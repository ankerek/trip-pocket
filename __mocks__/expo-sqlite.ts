import BetterSqlite3 from 'better-sqlite3';

export type SQLiteRunResult = {
  lastInsertRowId: number;
  changes: number;
};

export interface MockSQLiteDatabase {
  execAsync(sql: string): Promise<void>;
  getFirstAsync<T>(sql: string, ...params: unknown[]): Promise<T | null>;
  getAllAsync<T>(sql: string, ...params: unknown[]): Promise<T[]>;
  runAsync(sql: string, ...params: unknown[]): Promise<SQLiteRunResult>;
  withTransactionAsync(fn: () => Promise<void>): Promise<void>;
}

export async function openDatabaseAsync(_name: string): Promise<MockSQLiteDatabase> {
  // Always use :memory: in tests; real paths are not needed in the Node env
  const db = new BetterSqlite3(':memory:');

  return {
    async execAsync(sql: string): Promise<void> {
      db.exec(sql);
    },

    async getFirstAsync<T>(sql: string, ...params: unknown[]): Promise<T | null> {
      const stmt = db.prepare(sql);
      const row = stmt.get(...params) as T | undefined;
      return row ?? null;
    },

    async getAllAsync<T>(sql: string, ...params: unknown[]): Promise<T[]> {
      const stmt = db.prepare(sql);
      return stmt.all(...params) as T[];
    },

    async runAsync(sql: string, ...params: unknown[]): Promise<SQLiteRunResult> {
      const stmt = db.prepare(sql);
      const info = stmt.run(...params);
      return {
        lastInsertRowId: Number(info.lastInsertRowid),
        changes: info.changes,
      };
    },

    async withTransactionAsync(fn: () => Promise<void>): Promise<void> {
      db.exec('BEGIN');
      try {
        await fn();
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
  };
}

// Minimal SQLiteDatabase type alias so db.ts can reference it
export type SQLiteDatabase = MockSQLiteDatabase;
