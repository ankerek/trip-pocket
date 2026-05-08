import { openDatabase, runMigrations, getMigrationVersion, type Database } from '../db';
import { migrations } from '../migrations';

async function freshDb(): Promise<Database> {
  const db = await openDatabase(':memory:');
  await runMigrations(db, migrations);
  return db;
}

describe('migration 0005 — place_enrichments + per-row tracking columns', () => {
  it('reaches version 5 after applying all migrations', async () => {
    const db = await freshDb();
    expect(await getMigrationVersion(db)).toBeGreaterThanOrEqual(5);
  });

  it('creates place_enrichments with the expected columns', async () => {
    const db = await freshDb();
    type Col = { name: string; type: string; notnull: number; pk: number };
    const cols = await db.getAllAsync<Col>(`PRAGMA table_info(place_enrichments)`);
    const byName = new Map(cols.map((c) => [c.name, c]));

    expect(byName.get('external_place_id')?.pk).toBe(1);
    expect(byName.get('external_place_id')?.notnull).toBe(1);
    expect(byName.get('photo_name')?.type.toUpperCase()).toBe('TEXT');
    expect(byName.get('description')?.type.toUpperCase()).toBe('TEXT');
    expect(byName.get('rating')?.type.toUpperCase()).toBe('REAL');
    expect(byName.get('price_level')?.type.toUpperCase()).toBe('INTEGER');
    expect(byName.get('external_url')?.type.toUpperCase()).toBe('TEXT');
    expect(byName.get('latitude')?.type.toUpperCase()).toBe('REAL');
    expect(byName.get('longitude')?.type.toUpperCase()).toBe('REAL');
    expect(byName.get('formatted_address')?.type.toUpperCase()).toBe('TEXT');
    expect(byName.get('fetched_at')?.notnull).toBe(1);
    expect(byName.get('model')?.notnull).toBe(1);
  });

  it('adds external_place_id, enrichment_status, enriched_at to extracted_places', async () => {
    const db = await freshDb();
    type Col = { name: string; type: string; dflt_value: string | null };
    const cols = await db.getAllAsync<Col>(`PRAGMA table_info(extracted_places)`);
    const byName = new Map(cols.map((c) => [c.name, c]));

    expect(byName.get('external_place_id')?.type.toUpperCase()).toBe('TEXT');
    expect(byName.get('enrichment_status')?.type.toUpperCase()).toBe('TEXT');
    // Default 'pending' ensures rows inserted by extraction need no extra writes.
    expect(byName.get('enrichment_status')?.dflt_value).toBe(`'pending'`);
    expect(byName.get('enriched_at')?.type.toUpperCase()).toBe('TEXT');
  });

  it('creates the external_place_id index', async () => {
    const db = await freshDb();
    const idx = await db.getAllAsync<{ name: string }>(
      `SELECT name FROM sqlite_master
        WHERE type = 'index' AND tbl_name = 'extracted_places'`,
    );
    expect(idx.map((r) => r.name)).toContain('idx_extracted_places_external_place_id');
  });

  it('inserts a place_enrichments row and joins it from extracted_places', async () => {
    const db = await freshDb();
    const ownerId = 'owner-1';
    const now = '2026-05-08T10:00:00.000Z';

    await db.runAsync(
      `INSERT INTO screenshots (
         id, file_path, content_hash, source, ocr_status,
         captured_at, owner_id, created_at, updated_at
       ) VALUES ('s1', '/tmp/s1.jpg', 'h1', 'manual', 'done', ?, ?, ?, ?)`,
      now, ownerId, now, now,
    );
    await db.runAsync(
      `INSERT INTO extracted_places (
         id, screenshot_id, name, city, address, category,
         external_place_id, enrichment_status, enriched_at,
         owner_id, created_at, updated_at
       ) VALUES ('p1', 's1', 'Kosoan', 'Tokyo', '1 Chome-24-23 Jiyugaoka', 'food',
                 'ChIJ-test', 'enriched', ?,
                 ?, ?, ?)`,
      now, ownerId, now, now,
    );
    await db.runAsync(
      `INSERT INTO place_enrichments (
         external_place_id, photo_name, description, rating, price_level,
         external_url, latitude, longitude, formatted_address,
         fetched_at, model
       ) VALUES ('ChIJ-test', 'places/ChIJ-test/photos/abc',
                 'Cozy 1950s tea house.', 4.5, 2,
                 'https://maps.google.com/?cid=1', 35.6076, 139.668,
                 '1 Chome-24-23 Jiyugaoka, Tokyo',
                 ?, 'gemini-2.5-flash-lite')`,
      now,
    );

    const row = await db.getFirstAsync<{
      name: string;
      photo_name: string;
      description: string;
      rating: number;
      latitude: number;
    }>(
      `SELECT ep.name, pe.photo_name, pe.description, pe.rating, pe.latitude
         FROM extracted_places ep
    LEFT JOIN place_enrichments pe ON pe.external_place_id = ep.external_place_id
        WHERE ep.id = 'p1'`,
    );

    expect(row).toBeTruthy();
    expect(row!.name).toBe('Kosoan');
    expect(row!.photo_name).toBe('places/ChIJ-test/photos/abc');
    expect(row!.description).toContain('tea house');
    expect(row!.rating).toBe(4.5);
    expect(row!.latitude).toBeCloseTo(35.6076);
  });

  it('defaults extracted_places.enrichment_status to pending when omitted', async () => {
    const db = await freshDb();
    const ownerId = 'owner-1';
    const now = '2026-05-08T10:00:00.000Z';

    await db.runAsync(
      `INSERT INTO screenshots (
         id, file_path, content_hash, source, ocr_status,
         captured_at, owner_id, created_at, updated_at
       ) VALUES ('s2', '/tmp/s2.jpg', 'h2', 'manual', 'done', ?, ?, ?, ?)`,
      now, ownerId, now, now,
    );
    await db.runAsync(
      `INSERT INTO extracted_places (
         id, screenshot_id, name, city, category,
         owner_id, created_at, updated_at
       ) VALUES ('p2', 's2', 'Mystery Cafe', 'Tokyo', 'food', ?, ?, ?)`,
      ownerId, now, now,
    );
    const row = await db.getFirstAsync<{ enrichment_status: string; external_place_id: string | null }>(
      `SELECT enrichment_status, external_place_id FROM extracted_places WHERE id = 'p2'`,
    );
    expect(row!.enrichment_status).toBe('pending');
    expect(row!.external_place_id).toBeNull();
  });

  it('two extracted_places rows can share one place_enrichments row', async () => {
    const db = await freshDb();
    const ownerId = 'owner-1';
    const now = '2026-05-08T10:00:00.000Z';

    for (const id of ['s3', 's4']) {
      await db.runAsync(
        `INSERT INTO screenshots (
           id, file_path, content_hash, source, ocr_status,
           captured_at, owner_id, created_at, updated_at
         ) VALUES (?, ?, ?, 'manual', 'done', ?, ?, ?, ?)`,
        id, `/tmp/${id}.jpg`, `h-${id}`, now, ownerId, now, now,
      );
    }
    for (const [pid, sid] of [['p3', 's3'], ['p4', 's4']] as const) {
      await db.runAsync(
        `INSERT INTO extracted_places (
           id, screenshot_id, name, city, category,
           external_place_id, enrichment_status, enriched_at,
           owner_id, created_at, updated_at
         ) VALUES (?, ?, 'Kosoan', 'Tokyo', 'food',
                   'ChIJ-shared', 'enriched', ?,
                   ?, ?, ?)`,
        pid, sid, now, ownerId, now, now,
      );
    }
    await db.runAsync(
      `INSERT INTO place_enrichments (
         external_place_id, photo_name, fetched_at, model
       ) VALUES ('ChIJ-shared', 'places/ChIJ-shared/photos/abc',
                 ?, 'gemini-2.5-flash-lite')`,
      now,
    );

    const rows = await db.getAllAsync<{ id: string; photo_name: string }>(
      `SELECT ep.id, pe.photo_name
         FROM extracted_places ep
         JOIN place_enrichments pe ON pe.external_place_id = ep.external_place_id
        WHERE ep.deleted_at IS NULL
     ORDER BY ep.id ASC`,
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]?.photo_name).toBe('places/ChIJ-shared/photos/abc');
    expect(rows[1]?.photo_name).toBe('places/ChIJ-shared/photos/abc');
  });
});
