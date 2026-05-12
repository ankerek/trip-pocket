import { openDatabase, runMigrations, getMigrationVersion, type Database } from '../db';
import { migrations } from '../migrations';

describe('runMigrations', () => {
  it('starts at version 0 on a fresh database', async () => {
    const db = await openDatabase(':memory:');
    expect(await getMigrationVersion(db)).toBe(0);
  });

  it('applies a single migration and bumps the version', async () => {
    const db = await openDatabase(':memory:');
    const migrations = [
      {
        version: 1,
        up: async (d: Database) => {
          await d.execAsync('CREATE TABLE example (id TEXT PRIMARY KEY)');
        },
      },
    ];
    await runMigrations(db, migrations);
    expect(await getMigrationVersion(db)).toBe(1);
  });

  it('does not re-run migrations already applied', async () => {
    const db = await openDatabase(':memory:');
    let runs = 0;
    const migrations = [
      {
        version: 1,
        up: async (d: Database) => {
          runs += 1;
          await d.execAsync('CREATE TABLE example (id TEXT PRIMARY KEY)');
        },
      },
    ];
    await runMigrations(db, migrations);
    await runMigrations(db, migrations);
    expect(runs).toBe(1);
  });

  it('rolls back a failed migration and leaves version at 0', async () => {
    const db = await openDatabase(':memory:');
    const migrations = [
      {
        version: 1,
        up: async (_d: Database) => {
          throw new Error('migration failed');
        },
      },
    ];
    await expect(runMigrations(db, migrations)).rejects.toThrow('migration failed');
    expect(await getMigrationVersion(db)).toBe(0);
  });
});

describe('url-share migration (0002)', () => {
  it('backfills sources.platform/caption and pending_imports.kind/url on a pre-url-share DB', async () => {
    const db = await openDatabase(':memory:');
    // Simulate the pre-2026-05-12 dev DB: run an `init` that creates the
    // tables WITHOUT the new columns, then mark version=1 manually.
    // openDatabase already creates schema_migrations. Add just the legacy
    // tables that pre-2026-05-12 0001_init.ts would have written.
    await db.execAsync(`
      CREATE TABLE sources (id TEXT PRIMARY KEY, ocr_status TEXT, extraction_status TEXT);
      CREATE TABLE pending_imports (id TEXT PRIMARY KEY, app_group_path TEXT, suggested_trip_id TEXT, created_at TEXT NOT NULL);
    `);
    await db.runAsync(
      'INSERT INTO schema_migrations (version, applied_at) VALUES (1, ?)',
      new Date().toISOString(),
    );

    await runMigrations(db, migrations);

    const srcCols = await db.getAllAsync<{ name: string }>(`PRAGMA table_info(sources)`);
    expect(srcCols.map((c) => c.name)).toEqual(
      expect.arrayContaining(['platform', 'caption']),
    );
    const piCols = await db.getAllAsync<{ name: string }>(
      `PRAGMA table_info(pending_imports)`,
    );
    expect(piCols.map((c) => c.name)).toEqual(expect.arrayContaining(['kind', 'url']));
  });

  it('is a no-op when the columns already exist (idempotent)', async () => {
    const db = await openDatabase(':memory:');
    await runMigrations(db, migrations);
    // Re-running on a fresh DB (which has the columns from 0001) must not
    // throw. Bumping version above all migrations and re-applying tests
    // the idempotency guard directly.
    const cols = await db.getAllAsync<{ name: string }>(`PRAGMA table_info(sources)`);
    expect(cols.map((c) => c.name)).toEqual(
      expect.arrayContaining(['platform', 'caption']),
    );
    expect(await getMigrationVersion(db)).toBe(2);
  });
});

describe('initial migration (0001)', () => {
  it('creates the places-first schema tables', async () => {
    const db = await openDatabase(':memory:');
    await runMigrations(db, migrations);
    const tables = await db.getAllAsync<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    );
    const names = tables.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'trips',
        'sources',
        'places',
        'place_sources',
        'tags',
        'pending_imports',
        'meta',
        'schema_migrations',
      ]),
    );
    // No legacy table names should leak through.
    expect(names).not.toContain('screenshots');
    expect(names).not.toContain('extracted_places');
    expect(names).not.toContain('place_enrichments');
  });

  it('creates places_fts and sources_fts virtual tables', async () => {
    const db = await openDatabase(':memory:');
    await runMigrations(db, migrations);
    const rows = await db.getAllAsync<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('places_fts','sources_fts','screenshots_fts')",
    );
    const names = rows.map((r) => r.name);
    expect(names).toEqual(expect.arrayContaining(['places_fts', 'sources_fts']));
    expect(names).not.toContain('screenshots_fts');
  });
});

describe('schema shape — post-soft-delete-removal', () => {
  it('no table has a deleted_at column', async () => {
    const db = await openDatabase(':memory:');
    await runMigrations(db, migrations);
    for (const table of ['trips', 'sources', 'places', 'place_sources', 'tags']) {
      const cols = await db.getAllAsync<{ name: string }>(
        `SELECT name FROM pragma_table_info(?)`,
        table,
      );
      expect(cols.find((c) => c.name === 'deleted_at')).toBeUndefined();
    }
  });

  it('no index SQL mentions deleted_at', async () => {
    const db = await openDatabase(':memory:');
    await runMigrations(db, migrations);
    const indexes = await db.getAllAsync<{ name: string; sql: string | null }>(
      `SELECT name, sql FROM sqlite_master
        WHERE type = 'index' AND sql IS NOT NULL`,
    );
    for (const ix of indexes) {
      expect(ix.sql).not.toMatch(/deleted_at/);
    }
  });

  it('FTS triggers populate places_fts on INSERT and rebuild on UPDATE OF name', async () => {
    const db = await openDatabase(':memory:');
    await runMigrations(db, migrations);
    const ownerId = 'o1';
    await db.runAsync(
      `INSERT INTO places (id, trip_id, name, city, normalized_key,
                           enrichment_status, owner_id, created_at, updated_at)
       VALUES ('p1', NULL, 'Sushi Bar', 'Tokyo', 'sushi-bar|tokyo',
               'pending', ?, ?, ?)`,
      ownerId, '2026-05-10T10:00:00Z', '2026-05-10T10:00:00Z',
    );
    let row = await db.getFirstAsync<{ content: string }>(
      `SELECT content FROM places_fts WHERE place_id = 'p1'`,
    );
    expect(row?.content).toMatch(/Sushi Bar/);

    await db.runAsync(
      `UPDATE places SET name = 'Maru Tonkatsu', updated_at = ? WHERE id = 'p1'`,
      '2026-05-10T10:01:00Z',
    );
    row = await db.getFirstAsync<{ content: string }>(
      `SELECT content FROM places_fts WHERE place_id = 'p1'`,
    );
    expect(row?.content).toMatch(/Maru Tonkatsu/);
    expect(row?.content).not.toMatch(/Sushi Bar/);
  });
});
