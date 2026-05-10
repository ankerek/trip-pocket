import { openDatabase, runMigrations, type Database } from '@/modules/storage/db';
import { migrations } from '@/modules/storage/migrations';
import { listAllSources, insertSource } from '@/modules/storage/sources';
import { cleanupOrphanSources } from '../cleanupOrphans';

const ownerId = '00000000-0000-0000-0000-000000000001';

async function freshDb(): Promise<Database> {
  const db = await openDatabase(':memory:');
  await runMigrations(db, migrations);
  return db;
}

async function seedRow(db: Database, id: string, filePath: string) {
  await insertSource(db, {
    id,
    tripId: null,
    filePath,
    contentHash: `hash-${id}`,
    origin: 'manual',
    capturedAt: '2026-05-07T00:00:00Z',
    ownerId,
  });
}

describe('cleanupOrphanSources', () => {
  it('hard-deletes rows whose file is missing and leaves live rows alone', async () => {
    const db = await freshDb();
    await seedRow(db, 'live-1', '/storage/live-1.jpg');
    await seedRow(db, 'orphan-1', '/storage/orphan-1.jpg');
    await seedRow(db, 'orphan-2', '/storage/orphan-2.jpg');

    const present = new Set(['/storage/live-1.jpg']);
    const removed = await cleanupOrphanSources(db, {
      fileExists: (uri) => present.has(uri),
    });

    expect(removed).toBe(2);
    const remaining = await listAllSources(db);
    expect(remaining.map((r) => r.id)).toEqual(['live-1']);
  });

  it('returns 0 and writes nothing when every file is present', async () => {
    const db = await freshDb();
    await seedRow(db, 'a', '/storage/a.jpg');
    await seedRow(db, 'b', '/storage/b.jpg');

    const removed = await cleanupOrphanSources(db, {
      fileExists: () => true,
    });

    expect(removed).toBe(0);
    const remaining = await listAllSources(db);
    expect(remaining).toHaveLength(2);
  });

  it('is idempotent on the second pass (hard-deleted rows are gone)', async () => {
    const db = await freshDb();
    await seedRow(db, 'gone', '/storage/gone.jpg');

    const first = await cleanupOrphanSources(db, {
      fileExists: () => false,
    });
    expect(first).toBe(1);

    // Second sweep finds nothing because the row was hard-deleted.
    const calls: string[] = [];
    const second = await cleanupOrphanSources(db, {
      fileExists: (uri) => {
        calls.push(uri);
        return false;
      },
    });
    expect(second).toBe(0);
    expect(calls).toEqual([]);
  });

  it('skips kind=url/pasted rows that have no file_path', async () => {
    const db = await freshDb();
    await insertSource(db, {
      id: 'url-1',
      kind: 'url',
      tripId: null,
      filePath: null,
      url: 'https://example.com/post',
      contentHash: 'h-url-1',
      origin: 'manual',
      capturedAt: '2026-05-07T00:00:00Z',
      ownerId,
    });
    await seedRow(db, 'img-1', '/storage/img-1.jpg');

    const removed = await cleanupOrphanSources(db, {
      fileExists: () => false,
    });

    // url-1 has no file_path so it isn't an orphan candidate; img-1 is.
    expect(removed).toBe(1);
    const remaining = await listAllSources(db);
    expect(remaining.map((r) => r.id).sort()).toEqual(['url-1']);
  });
});
