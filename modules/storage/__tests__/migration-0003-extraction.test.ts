import { openDatabase, runMigrations, getMigrationVersion, type Database } from '../db';
import { migrations } from '../migrations';

async function freshDb(): Promise<Database> {
  const db = await openDatabase(':memory:');
  await runMigrations(db, migrations);
  return db;
}

describe('migration 0003 — extraction geocoding columns', () => {
  it('reaches version 3 after applying all migrations', async () => {
    const db = await freshDb();
    expect(await getMigrationVersion(db)).toBeGreaterThanOrEqual(3);
  });

  it('adds latitude, longitude, formatted_address, apple_maps_url to extracted_places', async () => {
    const db = await freshDb();
    type Col = { name: string; type: string };
    const cols = await db.getAllAsync<Col>(`PRAGMA table_info(extracted_places)`);
    const byName = new Map(cols.map((c) => [c.name, c.type.toUpperCase()]));
    expect(byName.get('latitude')).toBe('REAL');
    expect(byName.get('longitude')).toBe('REAL');
    expect(byName.get('formatted_address')).toBe('TEXT');
    expect(byName.get('apple_maps_url')).toBe('TEXT');
  });

  it('inserts into extracted_places with all geocode fields populated', async () => {
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
         id, screenshot_id, name, city, category,
         latitude, longitude, formatted_address, apple_maps_url,
         owner_id, created_at, updated_at
       ) VALUES ('p1', 's1', 'Maru Tonkatsu', 'Tokyo', 'food',
                 35.6595, 139.7005, '4 Chome-7-10 Roppongi, Minato City, Tokyo',
                 'https://maps.apple.com/?ll=35.6595,139.7005&q=Maru%20Tonkatsu',
                 ?, ?, ?)`,
      ownerId, now, now,
    );
    const row = await db.getFirstAsync<{
      latitude: number;
      longitude: number;
      formatted_address: string;
      apple_maps_url: string;
    }>(
      `SELECT latitude, longitude, formatted_address, apple_maps_url
         FROM extracted_places WHERE id = 'p1'`,
    );
    expect(row).toBeTruthy();
    expect(row!.latitude).toBeCloseTo(35.6595);
    expect(row!.longitude).toBeCloseTo(139.7005);
    expect(row!.formatted_address).toContain('Roppongi');
    expect(row!.apple_maps_url).toContain('maps.apple.com');
  });

  it('inserts with NULL geocode fields when geocoding missed', async () => {
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
       ) VALUES ('p2', 's2', 'Mystery Cafe', 'Nowhereville', 'food', ?, ?, ?)`,
      ownerId, now, now,
    );
    const row = await db.getFirstAsync<{
      latitude: number | null;
      longitude: number | null;
      formatted_address: string | null;
      apple_maps_url: string | null;
    }>(
      `SELECT latitude, longitude, formatted_address, apple_maps_url
         FROM extracted_places WHERE id = 'p2'`,
    );
    expect(row).toBeTruthy();
    expect(row!.latitude).toBeNull();
    expect(row!.longitude).toBeNull();
    expect(row!.formatted_address).toBeNull();
    expect(row!.apple_maps_url).toBeNull();
  });

  it('creates the screenshot_id index on extracted_places', async () => {
    const db = await freshDb();
    const idx = await db.getAllAsync<{ name: string }>(
      `SELECT name FROM sqlite_master
        WHERE type = 'index' AND tbl_name = 'extracted_places'`,
    );
    const names = idx.map((r) => r.name);
    expect(names).toContain('idx_extracted_places_screenshot');
  });
});
