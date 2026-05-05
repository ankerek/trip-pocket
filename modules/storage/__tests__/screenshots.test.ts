import { openDatabase, runMigrations, type Database } from '../db';
import { migrations } from '../migrations';
import { insertScreenshot, listScreenshots } from '../screenshots';

const ownerId = '00000000-0000-0000-0000-000000000001';

async function freshDb(): Promise<Database> {
  const db = await openDatabase(':memory:');
  await runMigrations(db, migrations);
  return db;
}

describe('screenshots repository', () => {
  it('inserts a screenshot and returns it from listScreenshots', async () => {
    const db = await freshDb();
    await insertScreenshot(db, {
      id: 'a',
      tripId: null,
      filePath: '/sandbox/a.jpg',
      contentHash: 'hash-a',
      source: 'share',
      capturedAt: '2026-05-04T10:00:00Z',
      ownerId,
    });
    const rows = await listScreenshots(db, { tripId: null });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'a',
      tripId: null,
      filePath: '/sandbox/a.jpg',
      source: 'share',
    });
  });

  it('lists screenshots ordered newest first by captured_at', async () => {
    const db = await freshDb();
    await insertScreenshot(db, {
      id: 'a',
      tripId: null,
      filePath: '/x/a.jpg',
      contentHash: 'h-a',
      source: 'share',
      capturedAt: '2026-05-01T00:00:00Z',
      ownerId,
    });
    await insertScreenshot(db, {
      id: 'b',
      tripId: null,
      filePath: '/x/b.jpg',
      contentHash: 'h-b',
      source: 'share',
      capturedAt: '2026-05-04T00:00:00Z',
      ownerId,
    });
    const rows = await listScreenshots(db, { tripId: null });
    expect(rows.map((r) => r.id)).toEqual(['b', 'a']);
  });

  it('filters out soft-deleted screenshots', async () => {
    const db = await freshDb();
    await insertScreenshot(db, {
      id: 'a',
      tripId: null,
      filePath: '/x/a.jpg',
      contentHash: 'h-a',
      source: 'share',
      capturedAt: '2026-05-01T00:00:00Z',
      ownerId,
    });
    await db.runAsync(
      'UPDATE screenshots SET deleted_at = ? WHERE id = ?',
      '2026-05-04T00:00:00Z',
      'a',
    );
    const rows = await listScreenshots(db, { tripId: null });
    expect(rows).toEqual([]);
  });

  it('lists only screenshots for the given tripId when one is provided', async () => {
    const db = await freshDb();
    const tripId = '11111111-1111-1111-1111-111111111111';
    await db.runAsync(
      `INSERT INTO trips (id, name, owner_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      tripId,
      'Trip 1',
      ownerId,
      '2026-05-01T00:00:00Z',
      '2026-05-01T00:00:00Z',
    );
    await insertScreenshot(db, {
      id: 'a',
      tripId,
      filePath: '/x/a.jpg',
      contentHash: 'h-a',
      source: 'share',
      capturedAt: '2026-05-01T00:00:00Z',
      ownerId,
    });
    await insertScreenshot(db, {
      id: 'b',
      tripId: null,
      filePath: '/x/b.jpg',
      contentHash: 'h-b',
      source: 'share',
      capturedAt: '2026-05-01T00:00:00Z',
      ownerId,
    });

    const inTrip = await listScreenshots(db, { tripId });
    expect(inTrip.map((r) => r.id)).toEqual(['a']);

    const inbox = await listScreenshots(db, { tripId: null });
    expect(inbox.map((r) => r.id)).toEqual(['b']);
  });
});
