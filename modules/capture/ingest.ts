import type { Database } from '@/modules/storage/db';
import { notifyChange } from '@/modules/storage/live-query';
import { importImage, type ImportFs } from './importImage';

export type IngestOptions = {
  ownerId: string;
  sandboxDir: string;
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
      await importImage(db, {
        sourceUri: p.app_group_path,
        source: 'share',
        ownerId: opts.ownerId,
        capturedAt: p.created_at,
        suggestedTripId: p.suggested_trip_id,
        transfer: 'move',
        sandboxDir: opts.sandboxDir,
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
