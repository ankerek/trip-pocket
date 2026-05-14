import { openDatabase, runMigrations, type Database } from '@/modules/storage/db';
import { migrations } from '@/modules/storage/migrations';
import { insertSource, deleteSource, assignSourceTrip } from '@/modules/storage/sources';
import { linkPlaceSource } from '@/modules/storage/place_sources';
import { deletePlace } from '@/modules/storage/places';
import { createTrip, deleteTrip } from '@/modules/storage/trips';

const ownerId = '00000000-0000-0000-0000-000000000001';

async function freshDb(): Promise<Database> {
  const db = await openDatabase(':memory:');
  await runMigrations(db, migrations);
  return db;
}

async function seedPlace(
  db: Database,
  id: string,
  name: string,
  tripId: string | null = null,
): Promise<void> {
  const now = '2026-05-10T10:00:00Z';
  await db.runAsync(
    `INSERT INTO places (id, trip_id, name, city, normalized_key,
                         enrichment_status, owner_id, created_at, updated_at)
     VALUES (?, ?, ?, 'Tokyo', ?, 'pending', ?, ?, ?)`,
    id,
    tripId,
    name,
    `${name.toLowerCase()}|tokyo`,
    ownerId,
    now,
    now,
  );
}

async function seedSource(
  db: Database,
  id: string,
  ocrText: string,
  tripId: string | null = null,
): Promise<void> {
  await insertSource(db, {
    id,
    tripId,
    filePath: `/x/${id}.jpg`,
    contentHash: `h-${id}`,
    origin: 'manual',
    capturedAt: '2026-05-10T10:00:00Z',
    ownerId,
  });
  await db.runAsync(`UPDATE sources SET ocr_text = ? WHERE id = ?`, ocrText, id);
}

const link = async (
  db: Database,
  placeId: string,
  sourceId: string,
  rawText?: string,
): Promise<void> => {
  await linkPlaceSource(db, {
    placeId,
    sourceId,
    rawText: rawText ?? null,
    extractionModel: 'gemini',
    ownerId,
  });
};

describe('FTS cascade behaviour', () => {
  it('deleteSource that orphan-prunes a place removes the place from places_fts', async () => {
    const db = await freshDb();
    await seedSource(db, 's1', 'shibuya restaurant');
    await seedPlace(db, 'p1', 'Maru Tonkatsu');
    await link(db, 'p1', 's1');

    const before = await db.getAllAsync<{ place_id: string }>(
      `SELECT place_id FROM places_fts WHERE places_fts MATCH 'tonkatsu'`,
    );
    expect(before).toHaveLength(1);

    await deleteSource(db, 's1', { unlinkFile: () => {} });

    const after = await db.getAllAsync<{ place_id: string }>(
      `SELECT place_id FROM places_fts WHERE places_fts MATCH 'tonkatsu'`,
    );
    expect(after).toEqual([]);
  });

  it('deletePlace that orphan-prunes a source removes the source from sources_fts', async () => {
    const db = await freshDb();
    await seedSource(db, 's1', 'shibuya restaurant ocr');
    await seedPlace(db, 'p1', 'Maru Tonkatsu');
    await link(db, 'p1', 's1');

    const before = await db.getAllAsync<{ source_id: string }>(
      `SELECT source_id FROM sources_fts WHERE sources_fts MATCH 'shibuya'`,
    );
    expect(before).toHaveLength(1);

    await deletePlace(db, 'p1', { unlinkFile: () => {} });

    const after = await db.getAllAsync<{ source_id: string }>(
      `SELECT source_id FROM sources_fts WHERE sources_fts MATCH 'shibuya'`,
    );
    expect(after).toEqual([]);
  });

  it('junction-only delete via assignSourceTrip rebuilds places_fts without the dropped source', async () => {
    const db = await freshDb();
    await createTrip(db, { id: 't1', name: 'Japan', ownerId });
    await seedSource(db, 's1', 'ocr-1');
    await seedSource(db, 's2', 'ocr-2');
    await seedPlace(db, 'p1', 'Maru Tonkatsu');
    await link(db, 'p1', 's1', 'rawtext-from-s1');
    await link(db, 'p1', 's2', 'rawtext-from-s2');

    // Drop s2's junction via excludePlaceIds.
    await assignSourceTrip(db, 's2', 't1', { excludePlaceIds: ['p1'] });

    const row = await db.getFirstAsync<{ content: string }>(
      `SELECT content FROM places_fts WHERE place_id = 'p1'`,
    );
    expect(row?.content).toMatch(/rawtext-from-s1/);
    expect(row?.content).not.toMatch(/rawtext-from-s2/);
  });

  it('cascade trip delete clears both FTS tables of the deleted ids', async () => {
    const db = await freshDb();
    await createTrip(db, { id: 't1', name: 'Japan', ownerId });
    await seedSource(db, 's1', 'shibuya', 't1');
    await seedPlace(db, 'p1', 'Maru Tonkatsu', 't1');
    await link(db, 'p1', 's1');

    await deleteTrip(db, 't1', 'cascade', { unlinkFile: () => {} });

    const placesFts = await db.getAllAsync(`SELECT place_id FROM places_fts`);
    const sourcesFts = await db.getAllAsync(`SELECT source_id FROM sources_fts`);
    expect(placesFts).toEqual([]);
    expect(sourcesFts).toEqual([]);
  });
});
