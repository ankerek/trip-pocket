import { v4 as uuidv4 } from 'uuid';
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
  }>('SELECT * FROM pending_imports ORDER BY created_at ASC');

  for (const p of pending) {
    const screenshotId = uuidv4();
    const target = `${opts.sandboxDir}/${screenshotId}.jpg`;
    await opts.fs.moveFile(p.app_group_path, target);

    // No content_hash in Phase 1 — column is NOT NULL in schema, so we stamp the
    // image filename's UUID as the placeholder. Phase 2 replaces with a real hash
    // and adds a unique index that this row will be allowed to keep (UUIDs don't
    // collide). The architecture allows this because Phase 1 has no dedup logic.
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
  }

  if (pending.length > 0) {
    notifyChange('screenshots');
    notifyChange('pending_imports');
  }
}
