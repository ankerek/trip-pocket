import { openDatabase, runMigrations, getMigrationVersion, type Database } from '../db';

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
