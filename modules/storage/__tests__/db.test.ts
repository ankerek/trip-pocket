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
