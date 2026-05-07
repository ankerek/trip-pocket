import { openDatabase, runMigrations, type Database } from '@/modules/storage/db';
import { migrations } from '@/modules/storage/migrations';
import { listScreenshots } from '@/modules/storage/screenshots';
import { ingestPendingImports } from '../ingest';
import type { ImportFs } from '../importImage';

const ownerId = '00000000-0000-0000-0000-000000000001';

async function freshDb(): Promise<Database> {
  const db = await openDatabase(':memory:');
  await runMigrations(db, migrations);
  return db;
}

function makeFs(overrides: Partial<ImportFs> = {}): ImportFs & {
  move: jest.Mock;
  copy: jest.Mock;
  unlink: jest.Mock;
  sha256: jest.Mock;
} {
  return {
    sha256: jest.fn(async (uri: string) => `sha-of:${uri}`),
    copy: jest.fn(async () => undefined),
    move: jest.fn(async () => undefined),
    unlink: jest.fn(async () => undefined),
    ...overrides,
  } as ImportFs & {
    move: jest.Mock;
    copy: jest.Mock;
    unlink: jest.Mock;
    sha256: jest.Mock;
  };
}

describe('ingestPendingImports', () => {
  it('drains a pending import into a screenshots row with a real content hash', async () => {
    const db = await freshDb();
    await db.runAsync(
      `INSERT INTO pending_imports (id, app_group_path, suggested_trip_id, created_at)
       VALUES (?, ?, NULL, ?)`,
      'p1',
      '/appgroup/img1.jpg',
      '2026-05-04T10:00:00Z',
    );

    const fs = makeFs();
    await ingestPendingImports(db, {
      ownerId,
      storageDir: '/sandbox',
      fs,
    });

    const rows = await listScreenshots(db, { tripId: null });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      filePath: expect.stringContaining('/sandbox/'),
      source: 'share',
      tripId: null,
      contentHash: 'sha-of:/appgroup/img1.jpg',
    });
    expect(fs.move).toHaveBeenCalledTimes(1);
    expect(await db.getAllAsync('SELECT * FROM pending_imports')).toEqual([]);
  });

  it('drains multiple pending imports in created_at order', async () => {
    const db = await freshDb();
    await db.runAsync(
      `INSERT INTO pending_imports (id, app_group_path, suggested_trip_id, created_at)
       VALUES ('p2', '/appgroup/b.jpg', NULL, '2026-05-04T10:00:01Z'),
              ('p1', '/appgroup/a.jpg', NULL, '2026-05-04T10:00:00Z')`,
    );

    const fs = makeFs();
    await ingestPendingImports(db, { ownerId, storageDir: '/sandbox', fs });

    expect(fs.move).toHaveBeenCalledTimes(2);
    expect(fs.move.mock.calls[0]?.[0]).toBe('/appgroup/a.jpg');
    expect(fs.move.mock.calls[1]?.[0]).toBe('/appgroup/b.jpg');
  });

  it('skips a row whose move rejects, keeps draining the rest', async () => {
    const flaky = makeFs({
      move: jest
        .fn<Promise<void>, [string, string]>()
        .mockImplementationOnce(async () => {
          throw new Error('disk pressure');
        })
        .mockImplementation(async () => undefined),
    });
    const db = await freshDb();
    await db.runAsync(
      `INSERT INTO pending_imports (id, app_group_path, suggested_trip_id, created_at)
       VALUES ('p1', '/appgroup/a.jpg', NULL, '2026-05-04T10:00:00Z'),
              ('p2', '/appgroup/b.jpg', NULL, '2026-05-04T10:00:01Z')`,
    );

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await ingestPendingImports(db, { ownerId, storageDir: '/sandbox', fs: flaky });
    } finally {
      warnSpy.mockRestore();
    }

    const rows = await listScreenshots(db, { tripId: null });
    expect(rows).toHaveLength(1);

    const remaining = await db.getAllAsync<{ id: string }>(
      'SELECT id FROM pending_imports ORDER BY id',
    );
    expect(remaining.map((r) => r.id)).toEqual(['p1']);
  });

  it('falls back to Inbox when suggested_trip_id points to a soft-deleted trip', async () => {
    const db = await freshDb();
    await db.runAsync(
      `INSERT INTO trips (id, name, owner_id, created_at, updated_at, deleted_at)
       VALUES ('t-gone', 'Old Trip', ?, '2026-05-01T00:00:00Z', '2026-05-01T00:00:00Z', '2026-05-06T00:00:00Z')`,
      ownerId,
    );
    await db.runAsync(
      `INSERT INTO pending_imports (id, app_group_path, suggested_trip_id, created_at)
       VALUES ('p1', '/appgroup/img1.jpg', 't-gone', '2026-05-07T10:00:00Z')`,
    );

    const fs = makeFs();
    await ingestPendingImports(db, { ownerId, storageDir: '/sandbox', fs });

    const inbox = await listScreenshots(db, { tripId: null });
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.tripId).toBeNull();

    expect(await db.getAllAsync('SELECT * FROM pending_imports')).toEqual([]);
  });

  it('falls back to Inbox when suggested_trip_id refers to a missing trip row', async () => {
    const db = await freshDb();
    await db.runAsync(
      `INSERT INTO pending_imports (id, app_group_path, suggested_trip_id, created_at)
       VALUES ('p1', '/appgroup/img1.jpg', 't-missing', '2026-05-07T10:00:00Z')`,
    );

    const fs = makeFs();
    await ingestPendingImports(db, { ownerId, storageDir: '/sandbox', fs });

    const inbox = await listScreenshots(db, { tripId: null });
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.tripId).toBeNull();
  });

  it('preserves suggested_trip_id when it points to an active trip', async () => {
    const db = await freshDb();
    await db.runAsync(
      `INSERT INTO trips (id, name, owner_id, created_at, updated_at)
       VALUES ('t-live', 'Japan', ?, '2026-05-01T00:00:00Z', '2026-05-01T00:00:00Z')`,
      ownerId,
    );
    await db.runAsync(
      `INSERT INTO pending_imports (id, app_group_path, suggested_trip_id, created_at)
       VALUES ('p1', '/appgroup/img1.jpg', 't-live', '2026-05-07T10:00:00Z')`,
    );

    const fs = makeFs();
    await ingestPendingImports(db, { ownerId, storageDir: '/sandbox', fs });

    const onTrip = await listScreenshots(db, { tripId: 't-live' });
    expect(onTrip).toHaveLength(1);
    expect(onTrip[0]?.tripId).toBe('t-live');
  });

  it('treats a duplicate hash as success (consumes pending row, does not insert twice)', async () => {
    const db = await freshDb();
    // Pre-existing active screenshot with the hash importImage will compute.
    await db.runAsync(
      `INSERT INTO screenshots
         (id, trip_id, file_path, content_hash, source,
          ocr_status, extraction_status, captured_at,
          owner_id, created_at, updated_at)
       VALUES ('seed', NULL, '/sandbox/seed.jpg', 'sha-of:/appgroup/dup.jpg', 'share',
               'pending', 'pending', '2026-05-04T09:00:00Z',
               ?, '2026-05-04T09:00:00Z', '2026-05-04T09:00:00Z')`,
      ownerId,
    );
    await db.runAsync(
      `INSERT INTO pending_imports (id, app_group_path, suggested_trip_id, created_at)
       VALUES ('p1', '/appgroup/dup.jpg', NULL, '2026-05-04T10:00:00Z')`,
    );

    const fs = makeFs();
    await ingestPendingImports(db, { ownerId, storageDir: '/sandbox', fs });

    const rows = await listScreenshots(db, { tripId: null });
    expect(rows).toHaveLength(1); // still just 'seed', no second row
    expect(await db.getAllAsync('SELECT * FROM pending_imports')).toEqual([]);
    // The duplicate path skipped move entirely.
    expect(fs.move).not.toHaveBeenCalled();
  });
});
