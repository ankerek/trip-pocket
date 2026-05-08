import { openDatabase, runMigrations, type Database } from '../db';
import { migrations } from '../migrations';
import {
  createTrip,
  listTrips,
  getTrip,
  renameTrip,
  softDeleteTrip,
} from '../trips';
import { insertSource, listSources } from '../sources';

const ownerId = '00000000-0000-0000-0000-000000000001';

async function freshDb(): Promise<Database> {
  const db = await openDatabase(':memory:');
  await runMigrations(db, migrations);
  return db;
}

describe('trips repository', () => {
  it('createTrip inserts a row and listTrips returns it', async () => {
    const db = await freshDb();
    await createTrip(db, { id: 't1', name: 'Japan', ownerId });
    const rows = await listTrips(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 't1', name: 'Japan', ownerId });
    expect(rows[0]?.color).toBeNull();
  });

  it('listTrips orders alphabetically case-insensitive and filters soft-deleted', async () => {
    const db = await freshDb();
    await createTrip(db, { id: 't1', name: 'iceland', ownerId });
    await createTrip(db, { id: 't2', name: 'Brazil', ownerId });
    await createTrip(db, { id: 't3', name: 'argentina', ownerId });
    await db.runAsync(
      'UPDATE trips SET deleted_at = ? WHERE id = ?',
      '2026-05-04T00:00:00Z',
      't2',
    );
    const rows = await listTrips(db);
    expect(rows.map((r) => r.name)).toEqual(['argentina', 'iceland']);
  });

  it('getTrip returns the active trip; null for soft-deleted or missing', async () => {
    const db = await freshDb();
    await createTrip(db, { id: 't1', name: 'Japan', ownerId });
    const t = await getTrip(db, 't1');
    expect(t?.name).toBe('Japan');

    await db.runAsync(
      'UPDATE trips SET deleted_at = ? WHERE id = ?',
      '2026-05-04T00:00:00Z',
      't1',
    );
    expect(await getTrip(db, 't1')).toBeNull();
    expect(await getTrip(db, 'missing')).toBeNull();
  });

  it('renameTrip updates name and updated_at', async () => {
    const db = await freshDb();
    await createTrip(db, { id: 't1', name: 'Japan', ownerId });
    const before = await getTrip(db, 't1');
    await new Promise((r) => setTimeout(r, 5));
    await renameTrip(db, { id: 't1', name: 'Nippon' });
    const after = await getTrip(db, 't1');
    expect(after?.name).toBe('Nippon');
    expect(after && before && after.updatedAt > before.updatedAt).toBe(true);
  });

  it('softDeleteTrip nulls trip_id on members and marks the trip deleted', async () => {
    const db = await freshDb();
    await createTrip(db, { id: 't1', name: 'Japan', ownerId });
    await insertSource(db, {
      id: 's1',
      tripId: 't1',
      filePath: '/x/s1.jpg',
      contentHash: 'h-s1',
      origin: 'manual',
      capturedAt: '2026-05-04T10:00:00Z',
      ownerId,
    });
    await insertSource(db, {
      id: 's2',
      tripId: 't1',
      filePath: '/x/s2.jpg',
      contentHash: 'h-s2',
      origin: 'manual',
      capturedAt: '2026-05-04T10:00:01Z',
      ownerId,
    });

    await softDeleteTrip(db, 't1');

    const trips = await listTrips(db);
    expect(trips).toEqual([]);

    const inbox = await listSources(db, { tripId: null });
    expect(inbox.map((r) => r.id).sort()).toEqual(['s1', 's2']);
  });

  it('softDeleteTrip leaves already-soft-deleted sources untouched', async () => {
    const db = await freshDb();
    await createTrip(db, { id: 't1', name: 'Japan', ownerId });
    await insertSource(db, {
      id: 's1',
      tripId: 't1',
      filePath: '/x/s1.jpg',
      contentHash: 'h-s1',
      origin: 'manual',
      capturedAt: '2026-05-04T10:00:00Z',
      ownerId,
    });
    await db.runAsync(
      'UPDATE sources SET deleted_at = ? WHERE id = ?',
      '2026-05-04T11:00:00Z',
      's1',
    );

    await softDeleteTrip(db, 't1');

    const row = await db.getFirstAsync<{ trip_id: string | null; deleted_at: string | null }>(
      'SELECT trip_id, deleted_at FROM sources WHERE id = ?',
      's1',
    );
    expect(row?.trip_id).toBe('t1');
    expect(row?.deleted_at).not.toBeNull();
  });
});
