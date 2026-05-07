import type { Database } from '@/modules/storage';

// live-query.ts owns the singleton database and exposes notifyChange + useLiveQuery,
// but does not export the raw handle. We re-read it via a tiny module-private getter
// to keep the singleton location DRY.
import { __getDatabaseForHooks } from './_databaseAccessor';

export function useDatabase(): Database | null {
  return __getDatabaseForHooks();
}
