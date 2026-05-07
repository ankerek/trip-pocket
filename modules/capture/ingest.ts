import type { Database } from '@/modules/storage/db';
import { notifyChange } from '@/modules/storage/live-query';
import { importImage, type ImportFs } from './importImage';

export type IngestOptions = {
  ownerId: string;
  storageDir: string;
  fs: ImportFs;
};

export async function ingestPendingImports(
  db: Database,
  opts: IngestOptions,
): Promise<void> {
  const pending = await db.getAllAsync<{
    id: string;
    app_group_path: string;
    suggested_trip_id: string | null;
    created_at: string;
  }>(
    `SELECT id, app_group_path, suggested_trip_id, created_at
       FROM pending_imports
   ORDER BY created_at ASC`,
  );

  let committed = 0;
  for (const p of pending) {
    try {
      let suggestedTripId = p.suggested_trip_id;
      if (suggestedTripId !== null) {
        // Trip may have been soft-deleted (or never existed) between when the
        // share extension wrote the pending row and now. Falling back to Inbox
        // beats orphaning the screenshot on a deleted trip.
        const live = await db.getFirstAsync<{ id: string }>(
          `SELECT id FROM trips WHERE id = ? AND deleted_at IS NULL`,
          suggestedTripId,
        );
        if (!live) suggestedTripId = null;
      }

      await importImage(db, {
        sourceUri: p.app_group_path,
        source: 'share',
        ownerId: opts.ownerId,
        capturedAt: p.created_at,
        suggestedTripId,
        transfer: 'move',
        storageDir: opts.storageDir,
        fs: opts.fs,
      });
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
