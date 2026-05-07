import { openDatabase, runMigrations, type Database } from '@/modules/storage/db';
import { migrations } from '@/modules/storage/migrations';
import { listAllScreenshots, insertScreenshot } from '@/modules/storage/screenshots';
import { cleanupOrphanScreenshots } from '../cleanupOrphans';

const ownerId = '00000000-0000-0000-0000-000000000001';

async function freshDb(): Promise<Database> {
  const db = await openDatabase(':memory:');
  await runMigrations(db, migrations);
  return db;
}

async function seedRow(db: Database, id: string, filePath: string) {
  await insertScreenshot(db, {
    id,
    tripId: null,
    filePath,
    contentHash: `hash-${id}`,
    source: 'manual',
    capturedAt: '2026-05-07T00:00:00Z',
    ownerId,
  });
}

describe('cleanupOrphanScreenshots', () => {
  it('soft-deletes rows whose file is missing and leaves live rows alone', async () => {
    const db = await freshDb();
    await seedRow(db, 'live-1', '/storage/live-1.jpg');
    await seedRow(db, 'orphan-1', '/storage/orphan-1.jpg');
    await seedRow(db, 'orphan-2', '/storage/orphan-2.jpg');

    const present = new Set(['/storage/live-1.jpg']);
    const removed = await cleanupOrphanScreenshots(db, {
      fileExists: (uri) => present.has(uri),
    });

    expect(removed).toBe(2);
    const remaining = await listAllScreenshots(db);
    expect(remaining.map((r) => r.id)).toEqual(['live-1']);
  });

  it('returns 0 and writes nothing when every file is present', async () => {
    const db = await freshDb();
    await seedRow(db, 'a', '/storage/a.jpg');
    await seedRow(db, 'b', '/storage/b.jpg');

    const removed = await cleanupOrphanScreenshots(db, {
      fileExists: () => true,
    });

    expect(removed).toBe(0);
    const remaining = await listAllScreenshots(db);
    expect(remaining).toHaveLength(2);
  });

  it('ignores already soft-deleted rows', async () => {
    const db = await freshDb();
    await seedRow(db, 'gone', '/storage/gone.jpg');
    await db.runAsync(
      `UPDATE screenshots SET deleted_at = ?, updated_at = ? WHERE id = ?`,
      '2026-05-07T00:00:00Z',
      '2026-05-07T00:00:00Z',
      'gone',
    );

    const calls: string[] = [];
    const removed = await cleanupOrphanScreenshots(db, {
      fileExists: (uri) => {
        calls.push(uri);
        return false;
      },
    });

    expect(removed).toBe(0);
    expect(calls).toEqual([]);
  });
});
