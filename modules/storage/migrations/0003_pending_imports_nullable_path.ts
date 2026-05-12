import type { Migration } from '../db';

// Pre-2026-05-12 dev DBs declared `pending_imports.app_group_path TEXT NOT NULL`.
// 4b5a10b relaxed the column to nullable so kind='url' rows could store NULL
// there, but only in the fresh-init path — SQLite ALTER TABLE cannot drop a
// NOT NULL constraint, so upgraded installs kept the old shape and URL shares
// failed with SQLITE_CONSTRAINT, surfacing as "Couldn't save" in the iOS share
// extension. This migration rebuilds the table on those installs. Idempotent
// via a notnull-bit guard so fresh installs (and re-runs) skip the rebuild.

export const pendingImportsNullablePath: Migration = {
  version: 3,
  up: async (db) => {
    const cols = await db.getAllAsync<{ name: string; notnull: number }>(
      `PRAGMA table_info(pending_imports)`,
    );
    const target = cols.find((c) => c.name === 'app_group_path');
    if (!target || target.notnull !== 1) return;

    // Standard SQLite "12-step" table rebuild, minus the FK steps —
    // pending_imports has no foreign keys in or out. Runs inside the
    // migration's own transaction (see runMigrations in ../db.ts).
    await db.execAsync(`
      CREATE TABLE pending_imports_new (
        id                TEXT PRIMARY KEY NOT NULL,
        kind              TEXT NOT NULL DEFAULT 'image'
                          CHECK (kind IN ('image','url')),
        app_group_path    TEXT,
        url               TEXT,
        suggested_trip_id TEXT,
        created_at        TEXT NOT NULL
      );
      INSERT INTO pending_imports_new (id, kind, app_group_path, url, suggested_trip_id, created_at)
        SELECT id, COALESCE(kind, 'image'), app_group_path, url, suggested_trip_id, created_at
          FROM pending_imports;
      DROP TABLE pending_imports;
      ALTER TABLE pending_imports_new RENAME TO pending_imports;
    `);
  },
};
