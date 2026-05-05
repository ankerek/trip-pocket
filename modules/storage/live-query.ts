import { useEffect, useState } from 'react';
import type { SQLiteBindValue } from 'expo-sqlite';
import type { Database } from './db';

let database: Database | null = null;
const listeners = new Map<string, Set<() => void>>();

export function provideDatabase(db: Database): void {
  database = db;
}

function getDatabase(): Database {
  if (!database) throw new Error('Database not provided. Call provideDatabase() at app boot.');
  return database;
}

export function notifyChange(table: string): void {
  listeners.get(table)?.forEach((fn) => fn());
}

function subscribe(tables: string[], fn: () => void): () => void {
  for (const t of tables) {
    if (!listeners.has(t)) listeners.set(t, new Set());
    listeners.get(t)!.add(fn);
  }
  return () => {
    for (const t of tables) {
      listeners.get(t)?.delete(fn);
    }
  };
}

export function useLiveQuery<Row>(
  sql: string,
  params: SQLiteBindValue[],
  tables: string[],
): Row[] | null {
  const [rows, setRows] = useState<Row[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      const result = await getDatabase().getAllAsync<Row>(sql, ...params);
      if (!cancelled) setRows(result);
    };
    run();
    const unsubscribe = subscribe(tables, run);
    return () => {
      cancelled = true;
      unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sql, JSON.stringify(params), tables.join(',')]);

  return rows;
}
