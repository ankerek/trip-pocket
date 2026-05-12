import type { Database } from '@/modules/storage/db';
import { notifyChange } from '@/modules/storage/live-query';
import { importImage, type ImportFs } from './importImage';
import { importUrl } from './importUrl';

export type IngestOptions = {
  ownerId: string;
  storageDir: string;
  fs: ImportFs;
};

type PendingRow = {
  id: string;
  kind: 'image' | 'url';
  app_group_path: string | null;
  url: string | null;
  suggested_trip_id: string | null;
  created_at: string;
};

export async function ingestPendingImports(
  db: Database,
  opts: IngestOptions,
): Promise<void> {
  // `kind` and `url` may not exist on tables created by older Swift
  // share-extension binaries (pre-2026-05-12). COALESCE the missing case
  // by guarding on table_info — but in practice the Swift writer's own
  // ALTER TABLE ADD COLUMN backfill (PendingImportWriter.swift) plugs the
  // gap before we ever read here.
  const pending = await db.getAllAsync<PendingRow>(
    `SELECT id, kind, app_group_path, url, suggested_trip_id, created_at
       FROM pending_imports
   ORDER BY created_at ASC`,
  );

  let committed = 0;
  for (const p of pending) {
    try {
      let suggestedTripId = p.suggested_trip_id;
      if (suggestedTripId !== null) {
        // Trip may have been deleted (or never existed) between when the
        // share extension wrote the pending row and now. Falling back to Inbox
        // beats orphaning the source on a deleted trip.
        const live = await db.getFirstAsync<{ id: string }>(
          `SELECT id FROM trips WHERE id = ?`,
          suggestedTripId,
        );
        if (!live) suggestedTripId = null;
      }

      if (p.kind === 'url') {
        if (!p.url) {
          // Malformed row — log and drain to avoid spinning on it.
          console.warn('[ingestPendingImports] kind=url with NULL url', p.id);
        } else {
          await importUrl(db, {
            url: p.url,
            origin: 'share',
            ownerId: opts.ownerId,
            capturedAt: p.created_at,
            suggestedTripId,
          });
        }
      } else {
        // 'image' (default) — same code path as before the URL feature.
        if (!p.app_group_path) {
          console.warn('[ingestPendingImports] kind=image with NULL path', p.id);
        } else {
          await importImage(db, {
            sourceUri: p.app_group_path,
            origin: 'share',
            ownerId: opts.ownerId,
            capturedAt: p.created_at,
            suggestedTripId,
            transfer: 'move',
            storageDir: opts.storageDir,
            fs: opts.fs,
          });
        }
      }
      // Both 'imported' and 'duplicate' are terminal: drain the pending row.
      await db.runAsync('DELETE FROM pending_imports WHERE id = ?', p.id);
      committed += 1;
    } catch (err) {
      console.warn('[ingestPendingImports] row failed', p.id, err);
    }
  }

  if (committed > 0) {
    notifyChange('pending_imports');
  }
}
