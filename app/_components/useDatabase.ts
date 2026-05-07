import { getDatabaseHandle, type Database } from '@/modules/storage';

// `live-query.ts` owns the singleton database (populated by `provideDatabase()` at app boot).
// This hook re-reads it via the public getter so we don't duplicate state.
// The hook is not reactive — populate the singleton before mounting any consumer
// (the RootLayout `if (!ready) return null;` guard ensures this in practice).
export function useDatabase(): Database | null {
  return getDatabaseHandle();
}
