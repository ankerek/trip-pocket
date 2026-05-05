import * as SQLite from 'expo-sqlite';

export type Database = SQLite.SQLiteDatabase;

export type Migration = {
  version: number;
  up: (db: Database) => Promise<void>;
};

export async function openDatabase(name = 'trip-pocket.db'): Promise<Database> {
  const db = await SQLite.openDatabaseAsync(name);
  await db.execAsync('PRAGMA journal_mode = WAL;');
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
    await db.withTransactionAsync(async () => {
      await m.up(db);
      await db.runAsync(
        'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)',
        m.version,
        new Date().toISOString(),
      );
    });
  }
}
