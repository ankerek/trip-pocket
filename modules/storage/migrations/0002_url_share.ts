import type { Migration } from '../db';

// Backfill for dev DBs initialised before the URL-share feature (spec
// docs/superpowers/specs/2026-05-12-url-share-extraction-design.md). For
// fresh installs the columns already exist via 0001_init.ts — this
// migration is a no-op there because the schema_migrations row is what
// gates re-running, not column presence. For pre-2026-05-12 DBs, the
// ALTER TABLEs add the columns the URL-share path reads/writes.
//
// We use a column-presence guard inside each ALTER so the migration is
// idempotent even on a DB where someone (e.g. the share-extension's
// own ALTER TABLE backfill in PendingImportWriter.swift) already plugged
// the missing column.

export const urlShare: Migration = {
  version: 2,
  up: async (db) => {
    await addColumnIfMissing(
      db,
      'sources',
      'platform',
      `TEXT CHECK (platform IS NULL OR platform IN ('instagram','tiktok'))`,
    );
    await addColumnIfMissing(db, 'sources', 'caption', `TEXT`);
    await addColumnIfMissing(
      db,
      'pending_imports',
      'kind',
      `TEXT NOT NULL DEFAULT 'image' CHECK (kind IN ('image','url'))`,
    );
    await addColumnIfMissing(db, 'pending_imports', 'url', `TEXT`);
  },
};

async function addColumnIfMissing(
  db: Parameters<Migration['up']>[0],
  table: string,
  column: string,
  ddl: string,
): Promise<void> {
  const cols = await db.getAllAsync<{ name: string }>(`PRAGMA table_info(${table})`);
  if (cols.some((c) => c.name === column)) return;
  await db.execAsync(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl};`);
}
