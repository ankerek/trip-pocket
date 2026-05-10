import { openDatabase, runMigrations, type Database } from '@/modules/storage/db';
import { migrations } from '@/modules/storage/migrations';
import { createTrip } from '@/modules/storage/trips';
import { insertSource } from '@/modules/storage/sources';
import { insertPlace, deletePlace } from '@/modules/storage/places';
import { linkPlaceSource } from '@/modules/storage/place_sources';
import { buildFtsMatch } from '../buildFtsMatch';

async function freshDb(): Promise<Database> {
  const db = await openDatabase(':memory:');
  await runMigrations(db, migrations);
  return db;
}

async function seedFts(db: Database, id: string, content: string): Promise<void> {
  await db.runAsync(
    'INSERT INTO sources_fts (source_id, content) VALUES (?, ?)',
    id,
    content,
  );
}

async function searchIds(db: Database, input: string): Promise<string[]> {
  const match = buildFtsMatch(input);
  if (match === null) return [];
  const rows = await db.getAllAsync<{ source_id: string }>(
    `SELECT source_id FROM sources_fts WHERE sources_fts MATCH ? ORDER BY rank`,
    match,
  );
  return rows.map((r) => r.source_id);
}

describe('search integration: buildFtsMatch -> sources_fts MATCH', () => {
  it('finds an English substring inside a longer OCR text', async () => {
    const db = await freshDb();
    await seedFts(db, 's1', 'Welcome to Maru Tonkatsu in Shibuya, Tokyo.');
    expect(await searchIds(db, 'tonk')).toEqual(['s1']);
  });

  it('finds a 3-codepoint CJK substring (not just prefix)', async () => {
    const db = await freshDb();
    await seedFts(db, 's1', 'とんかつ定食 ¥1500');
    expect(await searchIds(db, 'つ定食')).toEqual(['s1']);
  });

  it('returns no rows for a 2-char query (below trigram minimum, helper short-circuits)', async () => {
    const db = await freshDb();
    await seedFts(db, 's1', 'tonkatsu');
    expect(await searchIds(db, 'to')).toEqual([]);
  });

  it('AND-joins multiple tokens (both must appear, order independent)', async () => {
    const db = await freshDb();
    await seedFts(db, 'both', 'Maru Tonkatsu in Shibuya');
    await seedFts(db, 'tonkOnly', 'Some other tonkatsu place');
    await seedFts(db, 'shibuyaOnly', 'Random Shibuya note');
    expect(await searchIds(db, 'tonkatsu shibuya')).toEqual(['both']);
  });

  it("survives a real apostrophe in the input (O'Brien) without SQL injection", async () => {
    const db = await freshDb();
    await seedFts(db, 's1', "Visit O'Brien's Pub in Dublin");
    expect(await searchIds(db, "o'brien")).toEqual(['s1']);
  });

  it('quoting * does not turn it into a prefix operator (literal star)', async () => {
    const db = await freshDb();
    await seedFts(db, 's1', 'rated 5*** experience');
    await seedFts(db, 's2', 'plain text');
    expect(await searchIds(db, '5***')).toEqual(['s1']);
  });

  it('a query that fails to parse as FTS5 throws, not silently masks (sanity check on quoting)', async () => {
    const db = await freshDb();
    await seedFts(db, 's1', 'event (sold out) tomorrow');
    await expect(searchIds(db, '(sold')).resolves.toEqual(['s1']);
  });
});

// Places-first search exercises real triggers: insertPlace fires places_fts_ai
// (name/city/description only) and linkPlaceSource fires place_sources_fts_ai
// (rebuilds the FTS doc with raw_text + extracted_address). The screen's
// SEARCH_SQL is duplicated verbatim here so the test catches drift.
const PLACE_SEARCH_SQL = `
  SELECT p.id          AS id,
         p.name        AS name,
         p.city        AS city,
         p.category    AS category,
         p.photo_name  AS photo_name,
         p.trip_id     AS trip_id,
         t.name        AS trip_name
    FROM places_fts
    JOIN places p ON p.id = places_fts.place_id
    LEFT JOIN trips t ON t.id = p.trip_id
   WHERE places_fts MATCH ?
     AND (? IS NULL OR p.trip_id = ?)
ORDER BY rank
   LIMIT 50
`;

type PlaceResultRow = {
  id: string;
  name: string;
  city: string | null;
  category: string | null;
  photo_name: string | null;
  trip_id: string | null;
  trip_name: string | null;
};

async function placeSearch(
  db: Database,
  input: string,
  tripFilter: string | null,
): Promise<PlaceResultRow[]> {
  const match = buildFtsMatch(input);
  if (match === null) return [];
  return db.getAllAsync<PlaceResultRow>(
    PLACE_SEARCH_SQL,
    match,
    tripFilter,
    tripFilter,
  );
}

const OWNER = 'owner-1';

async function seedSource(db: Database, id: string, tripId: string | null): Promise<void> {
  await insertSource(db, {
    id,
    tripId,
    filePath: `/tmp/${id}.jpg`,
    contentHash: id,
    origin: 'manual',
    capturedAt: new Date().toISOString(),
    ownerId: OWNER,
  });
}

async function seedPlace(
  db: Database,
  opts: { id: string; tripId: string | null; name: string; city?: string; category?: string },
): Promise<void> {
  await insertPlace(db, {
    id: opts.id,
    tripId: opts.tripId,
    name: opts.name,
    city: opts.city ?? null,
    category: opts.category ?? null,
    ownerId: OWNER,
  });
}

async function seedTrip(db: Database, id: string, name: string): Promise<void> {
  await createTrip(db, { id, name, ownerId: OWNER });
}

describe('search integration: places_fts MATCH (places-first)', () => {
  it('finds a place by an OCR fragment carried via place_sources.raw_text', async () => {
    const db = await freshDb();
    await seedTrip(db, 'trip-1', 'Japan');
    await seedSource(db, 'src-1', 'trip-1');
    await seedPlace(db, { id: 'p1', tripId: 'trip-1', name: 'Maru Tonkatsu', city: 'Shibuya' });
    await linkPlaceSource(db, {
      placeId: 'p1',
      sourceId: 'src-1',
      rawText: 'Famous for crispy tonkatsu and a hidden basement bar.',
      extractionModel: 'test',
      ownerId: OWNER,
    });

    const results = await placeSearch(db, 'crispy', null);
    expect(results).toHaveLength(1);
    const [first] = results;
    expect(first?.id).toBe('p1');
    expect(first?.name).toBe('Maru Tonkatsu');
    expect(first?.trip_name).toBe('Japan');
  });

  it('narrows results when a trip filter is set', async () => {
    const db = await freshDb();
    await seedTrip(db, 'trip-jp', 'Japan');
    await seedTrip(db, 'trip-fr', 'France');
    await seedSource(db, 'src-jp', 'trip-jp');
    await seedSource(db, 'src-fr', 'trip-fr');
    await seedPlace(db, { id: 'p-jp', tripId: 'trip-jp', name: 'Maru Tonkatsu' });
    await seedPlace(db, { id: 'p-fr', tripId: 'trip-fr', name: 'Café Tonkin' });
    await linkPlaceSource(db, { placeId: 'p-jp', sourceId: 'src-jp', extractionModel: 't', ownerId: OWNER });
    await linkPlaceSource(db, { placeId: 'p-fr', sourceId: 'src-fr', extractionModel: 't', ownerId: OWNER });

    expect((await placeSearch(db, 'tonk', null)).map((r) => r.id).sort()).toEqual(['p-fr', 'p-jp']);
    expect((await placeSearch(db, 'tonk', 'trip-jp')).map((r) => r.id)).toEqual(['p-jp']);
    expect((await placeSearch(db, 'tonk', 'trip-fr')).map((r) => r.id)).toEqual(['p-fr']);
  });

  it('a place with trip_id IS NULL appears under "All trips" but is hidden by any trip filter', async () => {
    const db = await freshDb();
    await seedTrip(db, 'trip-1', 'Japan');
    await seedSource(db, 'src-orphan', null);
    await seedPlace(db, { id: 'orphan', tripId: null, name: 'Orphan Tonkatsu' });
    await linkPlaceSource(db, { placeId: 'orphan', sourceId: 'src-orphan', extractionModel: 't', ownerId: OWNER });

    expect((await placeSearch(db, 'tonk', null)).map((r) => r.id)).toEqual(['orphan']);
    expect((await placeSearch(db, 'tonk', 'trip-1')).map((r) => r.id)).toEqual([]);
  });

  it('deleting a place removes it from the result list', async () => {
    const db = await freshDb();
    await seedSource(db, 'src-1', null);
    await seedPlace(db, { id: 'p1', tripId: null, name: 'Tonkatsu Place' });
    await linkPlaceSource(db, { placeId: 'p1', sourceId: 'src-1', extractionModel: 't', ownerId: OWNER });
    expect((await placeSearch(db, 'tonk', null)).map((r) => r.id)).toEqual(['p1']);

    await deletePlace(db, 'p1', { unlinkFile: () => {} });
    expect((await placeSearch(db, 'tonk', null)).map((r) => r.id)).toEqual([]);
  });

  it('linking a new place_source rebuilds the FTS doc with the new raw_text', async () => {
    const db = await freshDb();
    await seedSource(db, 'src-1', null);
    await seedSource(db, 'src-2', null);
    await seedPlace(db, { id: 'p1', tripId: null, name: 'Some Place' });
    await linkPlaceSource(db, {
      placeId: 'p1',
      sourceId: 'src-1',
      rawText: 'first capture mentions ramen',
      extractionModel: 't',
      ownerId: OWNER,
    });
    expect((await placeSearch(db, 'ramen', null)).map((r) => r.id)).toEqual(['p1']);
    expect((await placeSearch(db, 'biryani', null))).toEqual([]);

    await linkPlaceSource(db, {
      placeId: 'p1',
      sourceId: 'src-2',
      rawText: 'second capture mentions biryani',
      extractionModel: 't',
      ownerId: OWNER,
    });
    expect((await placeSearch(db, 'ramen', null)).map((r) => r.id)).toEqual(['p1']);
    expect((await placeSearch(db, 'biryani', null)).map((r) => r.id)).toEqual(['p1']);
  });
});
