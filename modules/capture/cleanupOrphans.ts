import { File } from 'expo-file-system';
import type { Database } from '@/modules/storage/db';
import { notifyChange } from '@/modules/storage/live-query';

export type CleanupOrphansOptions = {
  fileExists?: (uri: string) => boolean;
};

/**
 * Soft-delete file-backed source rows whose file is no longer on disk. Catches
 * the case where a previous build wrote files into the main app's private
 * Documents directory (wiped on `expo run:ios` reinstall) while the SQLite DB
 * lived in the App Group container (which survives). Without this sweep those
 * rows show as ghost counts in the inbox with broken thumbnails.
 *
 * Only rows with a non-null file_path are candidates — url/pasted sources have
 * no local file to check. Returns the number of rows soft-deleted.
 */
export async function cleanupOrphanSources(
  db: Database,
  opts: CleanupOrphansOptions = {},
): Promise<number> {
  const fileExists = opts.fileExists ?? ((uri: string) => new File(uri).exists);

  const rows = await db.getAllAsync<{ id: string; file_path: string }>(
    `SELECT id, file_path FROM sources
      WHERE deleted_at IS NULL AND file_path IS NOT NULL`,
  );

  const orphans = rows.filter((r) => !fileExists(r.file_path));
  if (orphans.length === 0) return 0;

  const now = new Date().toISOString();
  for (const row of orphans) {
    await db.runAsync(
      `UPDATE sources SET deleted_at = ?, updated_at = ? WHERE id = ?`,
      now,
      now,
      row.id,
    );
  }
  notifyChange('sources');
  notifyChange('trips');
  return orphans.length;
}
