import { renderHook, act, waitFor } from '@testing-library/react-native';
import { openDatabase, runMigrations, type Database } from '../db';
import { migrations } from '../migrations';
import {
  insertSource,
  listSources,
  getSource,
  assignSourceTrip,
  softDeleteSource,
  listAllSources,
  listInboxSources,
  listSourcesByTrip,
  countSourcesByTrip,
} from '../sources';
import { createTrip } from '../trips';
import { provideDatabase, useLiveQuery } from '../live-query';

const ownerId = '00000000-0000-0000-0000-000000000001';

async function freshDb(): Promise<Database> {
  const db = await openDatabase(':memory:');
  await runMigrations(db, migrations);
  return db;
}

describe('sources repository', () => {
  it('inserts a source and returns it from listSources', async () => {
    const db = await freshDb();
    await insertSource(db, {
      id: 'a',
      tripId: null,
      filePath: '/sandbox/a.jpg',
      contentHash: 'hash-a',
      origin: 'share',
      capturedAt: '2026-05-04T10:00:00Z',
      ownerId,
    });
    const rows = await listSources(db, { tripId: null });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'a',
      kind: 'screenshot',
      tripId: null,
      filePath: '/sandbox/a.jpg',
      url: null,
      origin: 'share',
    });
  });

  it('lists sources ordered newest first by captured_at', async () => {
    const db = await freshDb();
    await insertSource(db, {
      id: 'a',
      tripId: null,
      filePath: '/x/a.jpg',
      contentHash: 'h-a',
      origin: 'share',
      capturedAt: '2026-05-01T00:00:00Z',
      ownerId,
    });
    await insertSource(db, {
      id: 'b',
      tripId: null,
      filePath: '/x/b.jpg',
      contentHash: 'h-b',
      origin: 'share',
      capturedAt: '2026-05-04T00:00:00Z',
      ownerId,
    });
    const rows = await listSources(db, { tripId: null });
    expect(rows.map((r) => r.id)).toEqual(['b', 'a']);
  });

  it('filters out soft-deleted sources', async () => {
    const db = await freshDb();
    await insertSource(db, {
      id: 'a',
      tripId: null,
      filePath: '/x/a.jpg',
      contentHash: 'h-a',
      origin: 'share',
      capturedAt: '2026-05-01T00:00:00Z',
      ownerId,
    });
    await db.runAsync(
      'UPDATE sources SET deleted_at = ? WHERE id = ?',
      '2026-05-04T00:00:00Z',
      'a',
    );
    const rows = await listSources(db, { tripId: null });
    expect(rows).toEqual([]);
  });

  it('lists only sources for the given tripId when one is provided', async () => {
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
    await insertSource(db, {
      id: 'a',
      tripId,
      filePath: '/x/a.jpg',
      contentHash: 'h-a',
      origin: 'share',
      capturedAt: '2026-05-01T00:00:00Z',
      ownerId,
    });
    await insertSource(db, {
      id: 'b',
      tripId: null,
      filePath: '/x/b.jpg',
      contentHash: 'h-b',
      origin: 'share',
      capturedAt: '2026-05-01T00:00:00Z',
      ownerId,
    });

    const inTrip = await listSources(db, { tripId });
    expect(inTrip.map((r) => r.id)).toEqual(['a']);

    const inbox = await listSources(db, { tripId: null });
    expect(inbox.map((r) => r.id)).toEqual(['b']);
  });
});

describe('sources additions', () => {
  it('getSource returns the active row; null for soft-deleted or missing', async () => {
    const db = await freshDb();
    await insertSource(db, {
      id: 'a',
      tripId: null,
      filePath: '/x/a.jpg',
      contentHash: 'h-a',
      origin: 'share',
      capturedAt: '2026-05-04T10:00:00Z',
      ownerId,
    });
    expect((await getSource(db, 'a'))?.id).toBe('a');

    await db.runAsync(
      'UPDATE sources SET deleted_at = ? WHERE id = ?',
      '2026-05-04T11:00:00Z',
      'a',
    );
    expect(await getSource(db, 'a')).toBeNull();
    expect(await getSource(db, 'missing')).toBeNull();
  });

  it('assignSourceTrip updates trip_id and updated_at', async () => {
    const db = await freshDb();
    await createTrip(db, { id: 't1', name: 'Japan', ownerId });
    await insertSource(db, {
      id: 'a',
      tripId: null,
      filePath: '/x/a.jpg',
      contentHash: 'h-a',
      origin: 'manual',
      capturedAt: '2026-05-04T10:00:00Z',
      ownerId,
    });
    const before = await getSource(db, 'a');
    await new Promise((r) => setTimeout(r, 5));
    await assignSourceTrip(db, 'a', 't1');
    const after = await getSource(db, 'a');
    expect(after?.tripId).toBe('t1');
    expect(after && before && after.updatedAt > before.updatedAt).toBe(true);

    await assignSourceTrip(db, 'a', null);
    expect((await getSource(db, 'a'))?.tripId).toBeNull();
  });

  it('assignSourceTrip cascades to untriaged linked places', async () => {
    const db = await freshDb();
    await createTrip(db, { id: 't1', name: 'Japan', ownerId });
    await createTrip(db, { id: 't2', name: 'Lisbon', ownerId });
    await insertSource(db, {
      id: 's1',
      tripId: null,
      filePath: '/x/s1.jpg',
      contentHash: 'h-s1',
      origin: 'manual',
      capturedAt: '2026-05-04T10:00:00Z',
      ownerId,
    });
    // Two places linked to s1 — one untriaged, one already in another trip.
    const now = '2026-05-08T10:00:00.000Z';
    await db.runAsync(
      `INSERT INTO places (id, trip_id, name, city, normalized_key,
                           enrichment_status, owner_id, created_at, updated_at)
       VALUES ('p1', NULL, 'Maru Tonkatsu', 'Tokyo', 'maru-tokyo', 'pending', ?, ?, ?)`,
      ownerId,
      now,
      now,
    );
    await db.runAsync(
      `INSERT INTO places (id, trip_id, name, city, normalized_key,
                           enrichment_status, owner_id, created_at, updated_at)
       VALUES ('p2', 't2', 'Pasteis', 'Lisbon', 'pasteis-lisbon', 'pending', ?, ?, ?)`,
      ownerId,
      now,
      now,
    );
    await db.runAsync(
      `INSERT INTO place_sources (place_id, source_id, extracted_at,
                                  extraction_model, owner_id, created_at, updated_at)
       VALUES ('p1', 's1', ?, 'gemini', ?, ?, ?)`,
      now,
      ownerId,
      now,
      now,
    );
    await db.runAsync(
      `INSERT INTO place_sources (place_id, source_id, extracted_at,
                                  extraction_model, owner_id, created_at, updated_at)
       VALUES ('p2', 's1', ?, 'gemini', ?, ?, ?)`,
      now,
      ownerId,
      now,
      now,
    );

    await assignSourceTrip(db, 's1', 't1');

    // The untriaged place follows the source.
    const p1 = await db.getFirstAsync<{ trip_id: string | null }>(
      `SELECT trip_id FROM places WHERE id = 'p1'`,
    );
    expect(p1?.trip_id).toBe('t1');
    // The already-triaged place stays where it was — we never yank.
    const p2 = await db.getFirstAsync<{ trip_id: string | null }>(
      `SELECT trip_id FROM places WHERE id = 'p2'`,
    );
    expect(p2?.trip_id).toBe('t2');
  });

  it('softDeleteSource sets deleted_at and removes the row from listings', async () => {
    const db = await freshDb();
    await insertSource(db, {
      id: 'a',
      tripId: null,
      filePath: '/x/a.jpg',
      contentHash: 'h-a',
      origin: 'manual',
      capturedAt: '2026-05-04T10:00:00Z',
      ownerId,
    });
    await softDeleteSource(db, 'a');
    const row = await db.getFirstAsync<{ deleted_at: string | null }>(
      'SELECT deleted_at FROM sources WHERE id = ?',
      'a',
    );
    expect(row?.deleted_at).not.toBeNull();
    expect(await listInboxSources(db)).toEqual([]);
  });

  it('listAllSources returns active rows regardless of trip, newest first', async () => {
    const db = await freshDb();
    await createTrip(db, { id: 't1', name: 'Japan', ownerId });
    await insertSource(db, {
      id: 'a',
      tripId: 't1',
      filePath: '/x/a.jpg',
      contentHash: 'h-a',
      origin: 'manual',
      capturedAt: '2026-05-04T10:00:00Z',
      ownerId,
    });
    await insertSource(db, {
      id: 'b',
      tripId: null,
      filePath: '/x/b.jpg',
      contentHash: 'h-b',
      origin: 'share',
      capturedAt: '2026-05-04T10:00:05Z',
      ownerId,
    });
    await insertSource(db, {
      id: 'c',
      tripId: null,
      filePath: '/x/c.jpg',
      contentHash: 'h-c',
      origin: 'share',
      capturedAt: '2026-05-04T10:00:01Z',
      ownerId,
    });
    await softDeleteSource(db, 'c');

    const rows = await listAllSources(db);
    expect(rows.map((r) => r.id)).toEqual(['b', 'a']);
  });

  it('listInboxSources returns only trip_id IS NULL active rows', async () => {
    const db = await freshDb();
    await createTrip(db, { id: 't1', name: 'Japan', ownerId });
    await insertSource(db, {
      id: 'a',
      tripId: 't1',
      filePath: '/x/a.jpg',
      contentHash: 'h-a',
      origin: 'manual',
      capturedAt: '2026-05-04T10:00:00Z',
      ownerId,
    });
    await insertSource(db, {
      id: 'b',
      tripId: null,
      filePath: '/x/b.jpg',
      contentHash: 'h-b',
      origin: 'share',
      capturedAt: '2026-05-04T10:00:01Z',
      ownerId,
    });
    const rows = await listInboxSources(db);
    expect(rows.map((r) => r.id)).toEqual(['b']);
  });

  it('listSourcesByTrip filters by tripId, newest first, honors limit', async () => {
    const db = await freshDb();
    await createTrip(db, { id: 't1', name: 'Japan', ownerId });
    for (let i = 1; i <= 7; i += 1) {
      await insertSource(db, {
        id: `s${i}`,
        tripId: 't1',
        filePath: `/x/s${i}.jpg`,
        contentHash: `h-${i}`,
        origin: 'manual',
        capturedAt: `2026-05-04T10:00:0${i}Z`,
        ownerId,
      });
    }
    const all = await listSourcesByTrip(db, 't1');
    expect(all).toHaveLength(7);
    expect(all[0]?.id).toBe('s7');

    const top5 = await listSourcesByTrip(db, 't1', 5);
    expect(top5.map((r) => r.id)).toEqual(['s7', 's6', 's5', 's4', 's3']);
  });

  it('countSourcesByTrip returns active counts keyed by trip_id', async () => {
    const db = await freshDb();
    await createTrip(db, { id: 't1', name: 'Japan', ownerId });
    await createTrip(db, { id: 't2', name: 'Italy', ownerId });
    await insertSource(db, {
      id: 'a',
      tripId: 't1',
      filePath: '/x/a.jpg',
      contentHash: 'h-a',
      origin: 'manual',
      capturedAt: '2026-05-04T10:00:00Z',
      ownerId,
    });
    await insertSource(db, {
      id: 'b',
      tripId: 't1',
      filePath: '/x/b.jpg',
      contentHash: 'h-b',
      origin: 'manual',
      capturedAt: '2026-05-04T10:00:01Z',
      ownerId,
    });
    await insertSource(db, {
      id: 'c',
      tripId: 't2',
      filePath: '/x/c.jpg',
      contentHash: 'h-c',
      origin: 'manual',
      capturedAt: '2026-05-04T10:00:02Z',
      ownerId,
    });
    await insertSource(db, {
      id: 'd',
      tripId: null,
      filePath: '/x/d.jpg',
      contentHash: 'h-d',
      origin: 'share',
      capturedAt: '2026-05-04T10:00:03Z',
      ownerId,
    });
    await softDeleteSource(db, 'b');

    const counts = await countSourcesByTrip(db);
    expect(counts).toEqual({ t1: 1, t2: 1 });
  });

  it('assignSourceTrip invalidates both sources and trips subscribers (via useLiveQuery)', async () => {
    const db = await freshDb();
    provideDatabase(db);
    await createTrip(db, { id: 't1', name: 'Japan', ownerId });
    await insertSource(db, {
      id: 'a',
      tripId: null,
      filePath: '/x/a.jpg',
      contentHash: 'h-a',
      origin: 'manual',
      capturedAt: '2026-05-04T10:00:00Z',
      ownerId,
    });

    const inboxHook = renderHook(() =>
      useLiveQuery<{ n: number }>(
        'SELECT COUNT(*) AS n FROM sources WHERE trip_id IS NULL AND deleted_at IS NULL',
        [],
        ['sources'],
      ),
    );
    const tripHook = renderHook(() =>
      useLiveQuery<{ n: number }>(
        'SELECT COUNT(*) AS n FROM sources WHERE trip_id = ? AND deleted_at IS NULL',
        ['t1'],
        ['trips'],
      ),
    );

    await waitFor(() => expect(inboxHook.result.current?.[0]?.n).toBe(1));
    await waitFor(() => expect(tripHook.result.current?.[0]?.n).toBe(0));

    await act(async () => {
      await assignSourceTrip(db, 'a', 't1');
    });

    await waitFor(() => expect(inboxHook.result.current?.[0]?.n).toBe(0));
    await waitFor(() => expect(tripHook.result.current?.[0]?.n).toBe(1));
  });
});
