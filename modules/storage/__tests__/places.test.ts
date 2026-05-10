import { openDatabase, runMigrations, type Database } from '../db';
import { migrations } from '../migrations';
import { createTrip } from '../trips';
import { insertSource, getSource } from '../sources';
import { countPlacesByTrip, deletePlace, movePlaceToTrip, normalizePlaceKey } from '../places';
import { linkPlaceSource } from '../place_sources';

const ownerId = '00000000-0000-0000-0000-000000000001';

async function freshDb(): Promise<Database> {
  const db = await openDatabase(':memory:');
  await runMigrations(db, migrations);
  return db;
}

async function seedPlace(
  db: Database,
  id: string,
  name: string,
  city: string,
  tripId: string | null,
): Promise<void> {
  const now = '2026-05-08T10:00:00.000Z';
  await db.runAsync(
    `INSERT INTO places (id, trip_id, name, city, normalized_key,
                         enrichment_status, owner_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
    id,
    tripId,
    name,
    city,
    normalizePlaceKey(name, city),
    ownerId,
    now,
    now,
  );
}

async function attach(db: Database, placeId: string, sourceId: string): Promise<void> {
  await linkPlaceSource(db, {
    placeId,
    sourceId,
    extractedAt: '2026-05-08T10:00:00Z',
    extractionModel: 'gemini-2.5-flash-lite',
    ownerId,
  });
}

describe('movePlaceToTrip — sources follow the place', () => {
  it('moves a single untriaged source to the trip when its only place is assigned', async () => {
    const db = await freshDb();
    await createTrip(db, { id: 't1', name: 'Japan', ownerId });
    await insertSource(db, {
      id: 's1',
      tripId: null,
      filePath: '/x/s1.jpg',
      contentHash: 'h-s1',
      origin: 'manual',
      capturedAt: '2026-05-08T10:00:00Z',
      ownerId,
    });
    await seedPlace(db, 'p1', 'Kosoan', 'Tokyo', null);
    await attach(db, 'p1', 's1');

    await movePlaceToTrip(db, 'p1', 't1');

    const s = await getSource(db, 's1');
    expect(s?.tripId).toBe('t1');
  });

  it('moves all untriaged sources attached to the place', async () => {
    const db = await freshDb();
    await createTrip(db, { id: 't1', name: 'Japan', ownerId });
    for (const id of ['s1', 's2', 's3']) {
      await insertSource(db, {
        id,
        tripId: null,
        filePath: `/x/${id}.jpg`,
        contentHash: `h-${id}`,
        origin: 'manual',
        capturedAt: '2026-05-08T10:00:00Z',
        ownerId,
      });
    }
    await seedPlace(db, 'p1', 'Kosoan', 'Tokyo', null);
    await attach(db, 'p1', 's1');
    await attach(db, 'p1', 's2');
    await attach(db, 'p1', 's3');

    await movePlaceToTrip(db, 'p1', 't1');

    expect((await getSource(db, 's1'))?.tripId).toBe('t1');
    expect((await getSource(db, 's2'))?.tripId).toBe('t1');
    expect((await getSource(db, 's3'))?.tripId).toBe('t1');
  });

  it('leaves a source alone when it already has a trip (preserves user intent)', async () => {
    const db = await freshDb();
    await createTrip(db, { id: 't1', name: 'Japan', ownerId });
    await createTrip(db, { id: 't2', name: 'Spain', ownerId });
    await insertSource(db, {
      id: 's-in-t2',
      tripId: 't2',
      filePath: '/x/s.jpg',
      contentHash: 'h-s',
      origin: 'manual',
      capturedAt: '2026-05-08T10:00:00Z',
      ownerId,
    });
    await seedPlace(db, 'p1', 'Kosoan', 'Tokyo', null);
    await attach(db, 'p1', 's-in-t2');

    await movePlaceToTrip(db, 'p1', 't1');

    // Source kept its existing trip; user already expressed intent for it.
    expect((await getSource(db, 's-in-t2'))?.tripId).toBe('t2');
  });

  it('only moves sources that are currently untriaged when the place has a mix', async () => {
    const db = await freshDb();
    await createTrip(db, { id: 't1', name: 'Japan', ownerId });
    await createTrip(db, { id: 't2', name: 'Spain', ownerId });
    await insertSource(db, {
      id: 's-untriaged',
      tripId: null,
      filePath: '/x/u.jpg',
      contentHash: 'h-u',
      origin: 'manual',
      capturedAt: '2026-05-08T10:00:00Z',
      ownerId,
    });
    await insertSource(db, {
      id: 's-in-t2',
      tripId: 't2',
      filePath: '/x/t2.jpg',
      contentHash: 'h-t2',
      origin: 'manual',
      capturedAt: '2026-05-08T10:00:00Z',
      ownerId,
    });
    await seedPlace(db, 'p1', 'Kosoan', 'Tokyo', null);
    await attach(db, 'p1', 's-untriaged');
    await attach(db, 'p1', 's-in-t2');

    await movePlaceToTrip(db, 'p1', 't1');

    expect((await getSource(db, 's-untriaged'))?.tripId).toBe('t1');
    expect((await getSource(db, 's-in-t2'))?.tripId).toBe('t2');
  });

  it('does NOT yank sources back to untriaged when the place is unassigned (tripId=null)', async () => {
    const db = await freshDb();
    await createTrip(db, { id: 't1', name: 'Japan', ownerId });
    await insertSource(db, {
      id: 's1',
      tripId: 't1',
      filePath: '/x/s.jpg',
      contentHash: 'h-s',
      origin: 'manual',
      capturedAt: '2026-05-08T10:00:00Z',
      ownerId,
    });
    await seedPlace(db, 'p1', 'Kosoan', 'Tokyo', 't1');
    await attach(db, 'p1', 's1');

    await movePlaceToTrip(db, 'p1', null);

    // Source stays put; only the place was unassigned.
    expect((await getSource(db, 's1'))?.tripId).toBe('t1');
  });

  it('skips already-deleted junctions when picking sources to move', async () => {
    const db = await freshDb();
    await createTrip(db, { id: 't1', name: 'Japan', ownerId });
    await insertSource(db, {
      id: 's-detached',
      tripId: null,
      filePath: '/x/s.jpg',
      contentHash: 'h-s',
      origin: 'manual',
      capturedAt: '2026-05-08T10:00:00Z',
      ownerId,
    });
    await seedPlace(db, 'p1', 'Kosoan', 'Tokyo', null);
    await attach(db, 'p1', 's-detached');
    // Junction was deleted (e.g. via a prior merge).
    await db.runAsync(
      `DELETE FROM place_sources WHERE place_id = ? AND source_id = ?`,
      'p1',
      's-detached',
    );

    await movePlaceToTrip(db, 'p1', 't1');

    // The junction was already gone; source stays untriaged.
    expect((await getSource(db, 's-detached'))?.tripId).toBeNull();
  });
});

describe('countPlacesByTrip', () => {
  it('returns counts grouped by trip_id', async () => {
    const db = await freshDb();
    await createTrip(db, { id: 't1', name: 'Japan', ownerId });
    await createTrip(db, { id: 't2', name: 'Lisbon', ownerId });
    await seedPlace(db, 'p1', 'A', 'Tokyo', 't1');
    await seedPlace(db, 'p2', 'B', 'Tokyo', 't1');
    await seedPlace(db, 'p3', 'C', 'Tokyo', 't1');
    await seedPlace(db, 'p4', 'D', 'Lisbon', 't2');

    const counts = await countPlacesByTrip(db);

    expect(counts).toEqual({ t1: 3, t2: 1 });
  });

  it('excludes places with null trip_id', async () => {
    const db = await freshDb();
    await createTrip(db, { id: 't1', name: 'Japan', ownerId });
    await seedPlace(db, 'p1', 'A', 'Tokyo', 't1');
    await seedPlace(db, 'p-untriaged', 'X', 'Anywhere', null);

    const counts = await countPlacesByTrip(db);

    expect(counts).toEqual({ t1: 1 });
  });

  it('excludes deleted places', async () => {
    const db = await freshDb();
    await createTrip(db, { id: 't1', name: 'Japan', ownerId });
    await seedPlace(db, 'p1', 'A', 'Tokyo', 't1');
    await seedPlace(db, 'p2', 'B', 'Tokyo', 't1');
    await deletePlace(db, 'p2', { unlinkFile: () => {} });

    const counts = await countPlacesByTrip(db);

    expect(counts).toEqual({ t1: 1 });
  });

  it('omits trips with no places (rather than returning zero)', async () => {
    const db = await freshDb();
    await createTrip(db, { id: 't-empty', name: 'Empty', ownerId });

    const counts = await countPlacesByTrip(db);

    expect(counts).toEqual({});
  });
});

describe('deletePlace — hard delete + symmetric orphan prune', () => {
  const seedSourceLocal = async (db: Database, id: string): Promise<void> => {
    const now = '2026-05-10T10:00:00Z';
    await insertSource(db, {
      id, tripId: null, filePath: `/x/${id}.jpg`,
      contentHash: `h-${id}`, origin: 'manual',
      capturedAt: now, ownerId,
    });
  };
  const link = async (db: Database, placeId: string, sourceId: string): Promise<void> => {
    await linkPlaceSource(db, {
      placeId, sourceId,
      extractionModel: 'gemini', ownerId,
    });
  };

  it('removes the place row and its junctions', async () => {
    const db = await freshDb();
    await seedSourceLocal(db, 's1');
    await seedPlace(db, 'p1', 'A', 'Tokyo', null);
    await link(db, 'p1', 's1');

    await deletePlace(db, 'p1', { unlinkFile: () => {} });

    const place = await db.getFirstAsync(`SELECT id FROM places WHERE id = 'p1'`);
    expect(place).toBeNull();
    const junctions = await db.getAllAsync(
      `SELECT source_id FROM place_sources WHERE place_id = 'p1'`,
    );
    expect(junctions).toEqual([]);
  });

  it('orphan-prunes a source whose only junction was to this place', async () => {
    const db = await freshDb();
    const deletedFiles: string[] = [];
    await seedSourceLocal(db, 'sOnlyHere');
    await seedPlace(db, 'p1', 'A', 'Tokyo', null);
    await link(db, 'p1', 'sOnlyHere');

    await deletePlace(db, 'p1', {
      unlinkFile: (p) => deletedFiles.push(p),
    });

    expect(await getSource(db, 'sOnlyHere')).toBeNull();
    expect(deletedFiles).toEqual(['/x/sOnlyHere.jpg']);
  });

  it('preserves a source that has another live place', async () => {
    const db = await freshDb();
    await seedSourceLocal(db, 'sShared');
    await seedPlace(db, 'p1', 'A', 'Tokyo', null);
    await seedPlace(db, 'p2', 'B', 'Tokyo', null);
    await link(db, 'p1', 'sShared');
    await link(db, 'p2', 'sShared');

    await deletePlace(db, 'p1', { unlinkFile: () => {} });

    expect(await getSource(db, 'sShared')).toBeTruthy();
    const remaining = await db.getAllAsync<{ place_id: string }>(
      `SELECT place_id FROM place_sources WHERE source_id = 'sShared'`,
    );
    expect(remaining.map((r) => r.place_id)).toEqual(['p2']);
  });

  it('handles a place with two sources, each only-linked here, by deleting both', async () => {
    const db = await freshDb();
    const deletedFiles: string[] = [];
    await seedSourceLocal(db, 's1');
    await seedSourceLocal(db, 's2');
    await seedPlace(db, 'p1', 'A', 'Tokyo', null);
    await link(db, 'p1', 's1');
    await link(db, 'p1', 's2');

    await deletePlace(db, 'p1', {
      unlinkFile: (p) => deletedFiles.push(p),
    });

    expect(await getSource(db, 's1')).toBeNull();
    expect(await getSource(db, 's2')).toBeNull();
    expect(deletedFiles.sort()).toEqual(['/x/s1.jpg', '/x/s2.jpg']);
  });
});
