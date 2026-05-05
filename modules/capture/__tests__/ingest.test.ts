import { openDatabase, runMigrations, type Database } from '@/modules/storage/db';
import { migrations } from '@/modules/storage/migrations';
import { listScreenshots } from '@/modules/storage/screenshots';
import { ingestPendingImports } from '../ingest';

const ownerId = '00000000-0000-0000-0000-000000000001';

async function freshDb(): Promise<Database> {
  const db = await openDatabase(':memory:');
  await runMigrations(db, migrations);
  return db;
}

const fakeFs = {
  moveFile: jest.fn(async (_from: string, _to: string) => undefined),
};

describe('ingestPendingImports', () => {
  beforeEach(() => {
    fakeFs.moveFile.mockClear();
  });

  it('drains a pending import into a screenshots row', async () => {
    const db = await freshDb();
    await db.runAsync(
      `INSERT INTO pending_imports (id, app_group_path, suggested_trip_id, created_at)
       VALUES (?, ?, NULL, ?)`,
      'p1',
      '/appgroup/img1.jpg',
      '2026-05-04T10:00:00Z',
    );

    await ingestPendingImports(db, {
      ownerId,
      sandboxDir: '/sandbox',
      fs: fakeFs,
    });

    const rows = await listScreenshots(db, { tripId: null });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      filePath: expect.stringContaining('/sandbox/'),
      source: 'share',
      tripId: null,
    });

    const remaining = await db.getAllAsync('SELECT * FROM pending_imports');
    expect(remaining).toEqual([]);
    expect(fakeFs.moveFile).toHaveBeenCalledTimes(1);
  });

  it('drains multiple pending imports in created_at order', async () => {
    const db = await freshDb();
    await db.runAsync(
      `INSERT INTO pending_imports (id, app_group_path, suggested_trip_id, created_at)
       VALUES ('p2', '/appgroup/b.jpg', NULL, '2026-05-04T10:00:01Z'),
              ('p1', '/appgroup/a.jpg', NULL, '2026-05-04T10:00:00Z')`,
    );

    await ingestPendingImports(db, {
      ownerId,
      sandboxDir: '/sandbox',
      fs: fakeFs,
    });

    expect(fakeFs.moveFile).toHaveBeenCalledTimes(2);
    expect(fakeFs.moveFile.mock.calls[0]?.[0]).toBe('/appgroup/a.jpg');
    expect(fakeFs.moveFile.mock.calls[1]?.[0]).toBe('/appgroup/b.jpg');
  });
});
