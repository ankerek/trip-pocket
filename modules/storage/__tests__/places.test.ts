import { openDatabase, runMigrations, type Database } from '../db';
import { migrations } from '../migrations';
import { createTrip } from '../trips';
import { insertSource, getSource } from '../sources';
import { countPlacesByTrip, movePlaceToTrip, normalizePlaceKey, softDeletePlace } from '../places';
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

  it('skips soft-deleted junctions when picking sources to move', async () => {
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
    // Soft-delete the junction (e.g. via a prior merge).
    await db.runAsync(
      `UPDATE place_sources SET deleted_at = ? WHERE place_id = ? AND source_id = ?`,
      '2026-05-08T11:00:00Z',
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

  it('excludes soft-deleted places', async () => {
    const db = await freshDb();
    await createTrip(db, { id: 't1', name: 'Japan', ownerId });
    await seedPlace(db, 'p1', 'A', 'Tokyo', 't1');
    await seedPlace(db, 'p2', 'B', 'Tokyo', 't1');
    await softDeletePlace(db, 'p2');

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
