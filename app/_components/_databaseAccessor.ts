import type { Database } from '@/modules/storage';

let cached: Database | null = null;

export function setDatabaseForHooks(db: Database): void {
  cached = db;
}

export function __getDatabaseForHooks(): Database | null {
  return cached;
}
