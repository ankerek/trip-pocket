import { File } from 'expo-file-system';
import type { Database } from '@/modules/storage/db';
import { notifyChange } from '@/modules/storage/live-query';

export type CleanupOrphansOptions = {
  fileExists?: (uri: string) => boolean;
};

/**
 * Soft-delete screenshot rows whose file is no longer on disk. Catches the case
 * where a previous build wrote files into the main app's private Documents
 * directory (wiped on `expo run:ios` reinstall) while the SQLite DB lived in the
 * App Group container (which survives). Without this sweep those rows show as
 * ghost counts in the inbox with broken thumbnails.
 *
 * Returns the number of rows deleted so callers can log/observe.
 */
export async function cleanupOrphanScreenshots(
  db: Database,
  opts: CleanupOrphansOptions = {},
): Promise<number> {
  const fileExists = opts.fileExists ?? ((uri: string) => new File(uri).exists);

  const rows = await db.getAllAsync<{ id: string; file_path: string }>(
    `SELECT id, file_path FROM screenshots WHERE deleted_at IS NULL`,
  );

  const orphans = rows.filter((r) => !fileExists(r.file_path));
  if (orphans.length === 0) return 0;

  const now = new Date().toISOString();
  for (const row of orphans) {
    await db.runAsync(
      `UPDATE screenshots SET deleted_at = ?, updated_at = ? WHERE id = ?`,
      now,
      now,
      row.id,
    );
  }
  notifyChange('screenshots');
  notifyChange('trips');
  return orphans.length;
}
