import * as Crypto from 'expo-crypto';
import type { Database } from '@/modules/storage/db';
import { insertScreenshot } from '@/modules/storage/screenshots';
import { notifyChange } from '@/modules/storage/live-query';

type FsLike = {
  moveFile: (from: string, to: string) => Promise<void>;
};

export type IngestOptions = {
  ownerId: string;
  sandboxDir: string;
  fs: FsLike;
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
    const screenshotId = Crypto.randomUUID();
    const target = `${opts.sandboxDir}/${screenshotId}.jpg`;
    try {
      // moveFile happens before the DB write. If insertScreenshot then throws,
      // the source file is gone — Phase 2 adds proper recovery; for now we log
      // and skip so a single bad row does not wedge the rest of the queue.
      await opts.fs.moveFile(p.app_group_path, target);

      // contentHash is the screenshot UUID (Phase 1 placeholder). Real content
      // hashing + dedup land in Phase 2 alongside delete; UUIDs trivially satisfy
      // the unique partial index in the meantime.
      await insertScreenshot(db, {
        id: screenshotId,
        tripId: p.suggested_trip_id,
        filePath: target,
        contentHash: screenshotId,
        source: 'share',
        capturedAt: p.created_at,
        ownerId: opts.ownerId,
      });

      await db.runAsync('DELETE FROM pending_imports WHERE id = ?', p.id);
      committed += 1;
    } catch (err) {
      console.warn('[ingestPendingImports] row failed', p.id, err);
    }
  }

  if (committed > 0) {
    notifyChange('screenshots');
    notifyChange('pending_imports');
  }
}
