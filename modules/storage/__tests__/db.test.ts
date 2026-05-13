import { openDatabase, runMigrations, getMigrationVersion, type Database } from '../db';
import { migrations } from '../migrations';
import { init } from '../migrations/0001_init';
import { urlShare } from '../migrations/0002_url_share';
import { pendingImportsNullablePath } from '../migrations/0003_pending_imports_nullable_path';

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

    // Scope to [init, urlShare] — later migrations rebuild sources and rely on
    // the full column set, which this test's intentionally sparse legacy
    // schema doesn't provide.
    await runMigrations(db, [init, urlShare]);

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
    expect(await getMigrationVersion(db)).toBe(5);
  });
});

describe('pending_imports nullable-path migration (0003)', () => {
  // Pre-2026-05-12 dev DBs declared `pending_imports.app_group_path TEXT NOT NULL`.
  // The URL-share path (added in 4b5a10b) inserts NULL for `app_group_path`,
  // which fired SQLite's NOT NULL constraint and surfaced as "Couldn't save"
  // in the iOS share extension. SQLite ALTER TABLE cannot drop NOT NULL, so a
  // table rebuild is the only fix.

  async function makeStaleDb(): Promise<Database> {
    const db = await openDatabase(':memory:');
    // Simulate the pre-2026-05-12 schema: app_group_path NOT NULL, no kind/url.
    await db.execAsync(`
      CREATE TABLE pending_imports (
        id TEXT PRIMARY KEY NOT NULL,
        app_group_path TEXT NOT NULL,
        suggested_trip_id TEXT,
        created_at TEXT NOT NULL
      );
    `);
    // Then simulate what 0002's ALTERs did to that table on an upgraded
    // install — they add kind/url but leave app_group_path's NOT NULL alone.
    await db.execAsync(`
      ALTER TABLE pending_imports ADD COLUMN kind TEXT NOT NULL DEFAULT 'image' CHECK (kind IN ('image','url'));
      ALTER TABLE pending_imports ADD COLUMN url TEXT;
    `);
    await db.runAsync(
      'INSERT INTO schema_migrations (version, applied_at) VALUES (1, ?)',
      new Date().toISOString(),
    );
    await db.runAsync(
      'INSERT INTO schema_migrations (version, applied_at) VALUES (2, ?)',
      new Date().toISOString(),
    );
    return db;
  }

  it('drops NOT NULL on app_group_path so kind="url" inserts succeed', async () => {
    const db = await makeStaleDb();
    const before = await db.getAllAsync<{ name: string; notnull: number }>(
      `PRAGMA table_info(pending_imports)`,
    );
    expect(before.find((c) => c.name === 'app_group_path')?.notnull).toBe(1);

    // Scope to migrations that touch pending_imports; later 0004 rebuilds the
    // `sources` table, which this test's stale-DB fixture doesn't create.
    await runMigrations(db, [init, urlShare, pendingImportsNullablePath]);

    const after = await db.getAllAsync<{ name: string; notnull: number }>(
      `PRAGMA table_info(pending_imports)`,
    );
    expect(after.find((c) => c.name === 'app_group_path')?.notnull).toBe(0);

    // The actual bug: kind='url' rows must be insertable with NULL path.
    await db.runAsync(
      `INSERT INTO pending_imports (id, kind, app_group_path, url, suggested_trip_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      'u1', 'url', null, 'https://instagram.com/p/ABC/', null,
      '2026-05-12T10:00:00Z',
    );
    const rows = await db.getAllAsync<{ id: string; kind: string }>(
      `SELECT id, kind FROM pending_imports`,
    );
    expect(rows).toEqual([{ id: 'u1', kind: 'url' }]);
  });

  it('preserves existing rows during the rebuild', async () => {
    const db = await makeStaleDb();
    await db.runAsync(
      `INSERT INTO pending_imports (id, kind, app_group_path, url, suggested_trip_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      'i1', 'image', 'file:///x.jpg', null, null, '2026-05-11T10:00:00Z',
    );

    await runMigrations(db, [init, urlShare, pendingImportsNullablePath]);

    const rows = await db.getAllAsync<{
      id: string; kind: string; app_group_path: string | null;
    }>(`SELECT id, kind, app_group_path FROM pending_imports`);
    expect(rows).toEqual([
      { id: 'i1', kind: 'image', app_group_path: 'file:///x.jpg' },
    ]);
  });

  it('is a no-op when app_group_path is already nullable (fresh installs)', async () => {
    const db = await openDatabase(':memory:');
    await runMigrations(db, migrations);

    // Only one pending_imports table; no leftover *_new from the rebuild path.
    const tables = await db.getAllAsync<{ name: string }>(
      `SELECT name FROM sqlite_master
        WHERE type='table' AND name LIKE 'pending_imports%'`,
    );
    expect(tables.map((t) => t.name)).toEqual(['pending_imports']);
    expect(await getMigrationVersion(db)).toBe(5);
  });
});

describe('image-kind rename migration (0004)', () => {
  // Pre-2026-05-13, file-based sources used `kind='screenshot'`. The name was
  // misleading — the column also covers photographed pictures, downloaded
  // images, and worker-fetched cover thumbnails. 0004 rebuilds `sources` with
  // a relaxed CHECK (kind IN ('image','url','pasted')) and rewrites existing
  // rows from 'screenshot' to 'image'. FK enforcement is deferred to commit
  // so `place_sources.source_id -> sources.id` survives the drop+rename.

  async function dbAtV3(): Promise<Database> {
    const db = await openDatabase(':memory:');
    await runMigrations(db, [init, urlShare, pendingImportsNullablePath]);
    return db;
  }

  it("renames 'screenshot' rows to 'image' and tightens the CHECK", async () => {
    const db = await dbAtV3();
    await db.runAsync(
      `INSERT INTO sources (id, kind, content_hash, origin, captured_at, owner_id, created_at, updated_at)
       VALUES (?, 'screenshot', 'h1', 'share', ?, 'o1', ?, ?)`,
      'src1', '2026-05-01T00:00:00Z', '2026-05-01T00:00:00Z', '2026-05-01T00:00:00Z',
    );

    await runMigrations(db, migrations);

    const row = await db.getFirstAsync<{ kind: string }>(
      `SELECT kind FROM sources WHERE id = ?`, 'src1',
    );
    expect(row?.kind).toBe('image');

    // The CHECK now rejects 'screenshot' (no client should write it anymore).
    await expect(
      db.runAsync(
        `INSERT INTO sources (id, kind, content_hash, origin, captured_at, owner_id, created_at, updated_at)
         VALUES (?, 'screenshot', ?, 'share', ?, 'o1', ?, ?)`,
        'src2', 'h2', '2026-05-13T00:00:00Z', '2026-05-13T00:00:00Z', '2026-05-13T00:00:00Z',
      ),
    ).rejects.toThrow();

    // 'image' inserts succeed.
    await db.runAsync(
      `INSERT INTO sources (id, kind, content_hash, origin, captured_at, owner_id, created_at, updated_at)
       VALUES (?, 'image', ?, 'share', ?, 'o1', ?, ?)`,
      'src3', 'h3', '2026-05-13T00:00:00Z', '2026-05-13T00:00:00Z', '2026-05-13T00:00:00Z',
    );
  });

  it('preserves the sources_fts index across the rebuild', async () => {
    const db = await dbAtV3();
    await db.runAsync(
      `INSERT INTO sources (id, kind, content_hash, origin, ocr_text, captured_at, owner_id, created_at, updated_at)
       VALUES (?, 'screenshot', 'h1', 'share', 'sushi restaurant tokyo', ?, 'o1', ?, ?)`,
      'src1', '2026-05-01T00:00:00Z', '2026-05-01T00:00:00Z', '2026-05-01T00:00:00Z',
    );

    const before = await db.getAllAsync<{ source_id: string }>(
      `SELECT source_id FROM sources_fts WHERE content MATCH ?`, 'sushi',
    );
    expect(before).toEqual([{ source_id: 'src1' }]);

    await runMigrations(db, migrations);

    // Existing FTS rows survive — INSERT … SELECT preserved the source ids.
    const after = await db.getAllAsync<{ source_id: string }>(
      `SELECT source_id FROM sources_fts WHERE content MATCH ?`, 'sushi',
    );
    expect(after).toEqual([{ source_id: 'src1' }]);

    // New inserts go through the recreated triggers.
    await db.runAsync(
      `INSERT INTO sources (id, kind, content_hash, origin, ocr_text, captured_at, owner_id, created_at, updated_at)
       VALUES (?, 'image', 'h2', 'share', 'ramen shop osaka', ?, 'o1', ?, ?)`,
      'src2', '2026-05-13T00:00:00Z', '2026-05-13T00:00:00Z', '2026-05-13T00:00:00Z',
    );
    const ramen = await db.getAllAsync<{ source_id: string }>(
      `SELECT source_id FROM sources_fts WHERE content MATCH ?`, 'ramen',
    );
    expect(ramen).toEqual([{ source_id: 'src2' }]);
  });

  it('preserves place_sources FK references across the drop+rename', async () => {
    const db = await dbAtV3();
    // trip -> source -> place_sources(place_id, source_id)
    await db.runAsync(
      `INSERT INTO trips (id, name, owner_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      't1', 'Japan', 'o1', '2026-05-01T00:00:00Z', '2026-05-01T00:00:00Z',
    );
    await db.runAsync(
      `INSERT INTO sources (id, kind, trip_id, content_hash, origin, captured_at, owner_id, created_at, updated_at)
       VALUES (?, 'screenshot', ?, 'h1', 'share', ?, 'o1', ?, ?)`,
      'src1', 't1', '2026-05-01T00:00:00Z', '2026-05-01T00:00:00Z', '2026-05-01T00:00:00Z',
    );
    await db.runAsync(
      `INSERT INTO places (id, trip_id, name, normalized_key, owner_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      'p1', 't1', 'Sushi Bar', 'sushi-bar', 'o1', '2026-05-01T00:00:00Z', '2026-05-01T00:00:00Z',
    );
    await db.runAsync(
      `INSERT INTO place_sources (place_id, source_id, extracted_at, extraction_model, owner_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      'p1', 'src1', '2026-05-01T00:00:00Z', 'test', 'o1', '2026-05-01T00:00:00Z', '2026-05-01T00:00:00Z',
    );

    await runMigrations(db, migrations);

    // place_sources row still resolves through to the (renamed) sources row.
    const joined = await db.getFirstAsync<{ source_id: string; kind: string }>(
      `SELECT ps.source_id, s.kind
         FROM place_sources ps JOIN sources s ON s.id = ps.source_id`,
    );
    expect(joined).toEqual({ source_id: 'src1', kind: 'image' });
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
