import { renderHook, act, waitFor } from '@testing-library/react-native';
import { openDatabase, runMigrations, type Database } from '../db';
import { migrations } from '../migrations';
import {
  insertScreenshot,
  listScreenshots,
  getScreenshot,
  assignTrip,
  softDeleteScreenshot,
  listAllScreenshots,
  listInbox,
  listScreenshotsByTrip,
  countByTrip,
} from '../screenshots';
import { createTrip } from '../trips';
import { provideDatabase, useLiveQuery } from '../live-query';

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

describe('screenshots additions', () => {
  it('getScreenshot returns the active row; null for soft-deleted or missing', async () => {
    const db = await freshDb();
    await insertScreenshot(db, {
      id: 'a',
      tripId: null,
      filePath: '/x/a.jpg',
      contentHash: 'h-a',
      source: 'share',
      capturedAt: '2026-05-04T10:00:00Z',
      ownerId,
    });
    expect((await getScreenshot(db, 'a'))?.id).toBe('a');

    await db.runAsync(
      'UPDATE screenshots SET deleted_at = ? WHERE id = ?',
      '2026-05-04T11:00:00Z',
      'a',
    );
    expect(await getScreenshot(db, 'a')).toBeNull();
    expect(await getScreenshot(db, 'missing')).toBeNull();
  });

  it('assignTrip updates trip_id and updated_at', async () => {
    const db = await freshDb();
    await createTrip(db, { id: 't1', name: 'Japan', ownerId });
    await insertScreenshot(db, {
      id: 'a',
      tripId: null,
      filePath: '/x/a.jpg',
      contentHash: 'h-a',
      source: 'manual',
      capturedAt: '2026-05-04T10:00:00Z',
      ownerId,
    });
    const before = await getScreenshot(db, 'a');
    await new Promise((r) => setTimeout(r, 5));
    await assignTrip(db, 'a', 't1');
    const after = await getScreenshot(db, 'a');
    expect(after?.tripId).toBe('t1');
    expect(after && before && after.updatedAt > before.updatedAt).toBe(true);

    await assignTrip(db, 'a', null);
    expect((await getScreenshot(db, 'a'))?.tripId).toBeNull();
  });

  it('softDeleteScreenshot sets deleted_at and removes the row from listings', async () => {
    const db = await freshDb();
    await insertScreenshot(db, {
      id: 'a',
      tripId: null,
      filePath: '/x/a.jpg',
      contentHash: 'h-a',
      source: 'manual',
      capturedAt: '2026-05-04T10:00:00Z',
      ownerId,
    });
    await softDeleteScreenshot(db, 'a');
    const row = await db.getFirstAsync<{ deleted_at: string | null }>(
      'SELECT deleted_at FROM screenshots WHERE id = ?',
      'a',
    );
    expect(row?.deleted_at).not.toBeNull();
    expect(await listInbox(db)).toEqual([]);
  });

  it('listAllScreenshots returns active rows regardless of trip, newest first', async () => {
    const db = await freshDb();
    await createTrip(db, { id: 't1', name: 'Japan', ownerId });
    await insertScreenshot(db, {
      id: 'a',
      tripId: 't1',
      filePath: '/x/a.jpg',
      contentHash: 'h-a',
      source: 'manual',
      capturedAt: '2026-05-04T10:00:00Z',
      ownerId,
    });
    await insertScreenshot(db, {
      id: 'b',
      tripId: null,
      filePath: '/x/b.jpg',
      contentHash: 'h-b',
      source: 'share',
      capturedAt: '2026-05-04T10:00:05Z',
      ownerId,
    });
    await insertScreenshot(db, {
      id: 'c',
      tripId: null,
      filePath: '/x/c.jpg',
      contentHash: 'h-c',
      source: 'share',
      capturedAt: '2026-05-04T10:00:01Z',
      ownerId,
    });
    await softDeleteScreenshot(db, 'c');

    const rows = await listAllScreenshots(db);
    expect(rows.map((r) => r.id)).toEqual(['b', 'a']);
  });

  it('listInbox returns only trip_id IS NULL active rows', async () => {
    const db = await freshDb();
    await createTrip(db, { id: 't1', name: 'Japan', ownerId });
    await insertScreenshot(db, {
      id: 'a',
      tripId: 't1',
      filePath: '/x/a.jpg',
      contentHash: 'h-a',
      source: 'manual',
      capturedAt: '2026-05-04T10:00:00Z',
      ownerId,
    });
    await insertScreenshot(db, {
      id: 'b',
      tripId: null,
      filePath: '/x/b.jpg',
      contentHash: 'h-b',
      source: 'share',
      capturedAt: '2026-05-04T10:00:01Z',
      ownerId,
    });
    const rows = await listInbox(db);
    expect(rows.map((r) => r.id)).toEqual(['b']);
  });

  it('listScreenshotsByTrip filters by tripId, newest first, honors limit', async () => {
    const db = await freshDb();
    await createTrip(db, { id: 't1', name: 'Japan', ownerId });
    for (let i = 1; i <= 7; i += 1) {
      await insertScreenshot(db, {
        id: `s${i}`,
        tripId: 't1',
        filePath: `/x/s${i}.jpg`,
        contentHash: `h-${i}`,
        source: 'manual',
        capturedAt: `2026-05-04T10:00:0${i}Z`,
        ownerId,
      });
    }
    const all = await listScreenshotsByTrip(db, 't1');
    expect(all).toHaveLength(7);
    expect(all[0]?.id).toBe('s7');

    const top5 = await listScreenshotsByTrip(db, 't1', 5);
    expect(top5.map((r) => r.id)).toEqual(['s7', 's6', 's5', 's4', 's3']);
  });

  it('countByTrip returns active counts keyed by trip_id', async () => {
    const db = await freshDb();
    await createTrip(db, { id: 't1', name: 'Japan', ownerId });
    await createTrip(db, { id: 't2', name: 'Italy', ownerId });
    await insertScreenshot(db, {
      id: 'a',
      tripId: 't1',
      filePath: '/x/a.jpg',
      contentHash: 'h-a',
      source: 'manual',
      capturedAt: '2026-05-04T10:00:00Z',
      ownerId,
    });
    await insertScreenshot(db, {
      id: 'b',
      tripId: 't1',
      filePath: '/x/b.jpg',
      contentHash: 'h-b',
      source: 'manual',
      capturedAt: '2026-05-04T10:00:01Z',
      ownerId,
    });
    await insertScreenshot(db, {
      id: 'c',
      tripId: 't2',
      filePath: '/x/c.jpg',
      contentHash: 'h-c',
      source: 'manual',
      capturedAt: '2026-05-04T10:00:02Z',
      ownerId,
    });
    await insertScreenshot(db, {
      id: 'd',
      tripId: null,
      filePath: '/x/d.jpg',
      contentHash: 'h-d',
      source: 'share',
      capturedAt: '2026-05-04T10:00:03Z',
      ownerId,
    });
    await softDeleteScreenshot(db, 'b');

    const counts = await countByTrip(db);
    expect(counts).toEqual({ t1: 1, t2: 1 });
  });

  it('assignTrip invalidates both screenshots and trips subscribers (via useLiveQuery)', async () => {
    const db = await freshDb();
    provideDatabase(db);
    await createTrip(db, { id: 't1', name: 'Japan', ownerId });
    await insertScreenshot(db, {
      id: 'a',
      tripId: null,
      filePath: '/x/a.jpg',
      contentHash: 'h-a',
      source: 'manual',
      capturedAt: '2026-05-04T10:00:00Z',
      ownerId,
    });

    const inboxHook = renderHook(() =>
      useLiveQuery<{ n: number }>(
        'SELECT COUNT(*) AS n FROM screenshots WHERE trip_id IS NULL AND deleted_at IS NULL',
        [],
        ['screenshots'],
      ),
    );
    const tripHook = renderHook(() =>
      useLiveQuery<{ n: number }>(
        'SELECT COUNT(*) AS n FROM screenshots WHERE trip_id = ? AND deleted_at IS NULL',
        ['t1'],
        ['trips'],
      ),
    );

    await waitFor(() => expect(inboxHook.result.current?.[0]?.n).toBe(1));
    await waitFor(() => expect(tripHook.result.current?.[0]?.n).toBe(0));

    await act(async () => {
      await assignTrip(db, 'a', 't1');
    });

    // Both subscribers must re-fire and observe the move:
    await waitFor(() => expect(inboxHook.result.current?.[0]?.n).toBe(0));
    await waitFor(() => expect(tripHook.result.current?.[0]?.n).toBe(1));
  });
});
