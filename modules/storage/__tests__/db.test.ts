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
  it('creates every Phase-1+v0.2+v1.0 table', async () => {
    const db = await openDatabase(':memory:');
    await runMigrations(db, migrations);
    const tables = await db.getAllAsync<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    );
    const names = tables.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'trips',
        'screenshots',
        'tags',
        'extracted_places',
        'pending_imports',
        'meta',
        'schema_migrations',
      ]),
    );
  });

  it('creates the screenshots_fts virtual table', async () => {
    const db = await openDatabase(':memory:');
    await runMigrations(db, migrations);
    const row = await db.getFirstAsync<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='screenshots_fts'",
    );
    expect(row?.name).toBe('screenshots_fts');
  });
});
