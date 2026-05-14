import * as SQLite from 'expo-sqlite';

export type Database = SQLite.SQLiteDatabase;

export type Migration = {
  version: number;
  up: (db: Database) => Promise<void>;
  // Some rebuilds (e.g. dropping + recreating a parent table to change its
  // CHECK constraint) can't run with FK enforcement on, and SQLite ignores
  // `PRAGMA foreign_keys` toggled inside an open transaction. When this flag
  // is set, runMigrations toggles FK off *before* the transaction begins and
  // back on after it commits. Use sparingly — most migrations should leave it
  // unset and let FK stay enforced.
  disableForeignKeys?: boolean;
};

export async function openDatabase(name = 'trip-pocket.db', directory?: string): Promise<Database> {
  const db = await SQLite.openDatabaseAsync(name, undefined, directory);
  await db.execAsync('PRAGMA journal_mode = WAL;');
  await db.execAsync('PRAGMA foreign_keys = ON;');
  await db.execAsync(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)',
  );
  return db;
}

export async function getMigrationVersion(db: Database): Promise<number> {
  const row = await db.getFirstAsync<{ v: number | null }>(
    'SELECT MAX(version) AS v FROM schema_migrations',
  );
  return row?.v ?? 0;
}

export async function runMigrations(db: Database, migrations: Migration[]): Promise<void> {
  const sorted = [...migrations].sort((a, b) => a.version - b.version);
  const current = await getMigrationVersion(db);
  for (const m of sorted) {
    if (m.version <= current) continue;
    if (m.disableForeignKeys) {
      await db.execAsync('PRAGMA foreign_keys = OFF;');
    }
    try {
      await db.withTransactionAsync(async () => {
        await m.up(db);
        await db.runAsync(
          'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)',
          m.version,
          new Date().toISOString(),
        );
      });
    } finally {
      if (m.disableForeignKeys) {
        await db.execAsync('PRAGMA foreign_keys = ON;');
      }
    }
  }
}
