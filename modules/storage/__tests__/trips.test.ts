import { openDatabase, runMigrations, type Database } from '../db';
import { migrations } from '../migrations';
import { createTrip, listTrips, getTrip, renameTrip, deleteTrip } from '../trips';
import { insertSource, listSources } from '../sources';
import { linkPlaceSource } from '../place_sources';

const ownerId = '00000000-0000-0000-0000-000000000001';

async function freshDb(): Promise<Database> {
  const db = await openDatabase(':memory:');
  await runMigrations(db, migrations);
  return db;
}

async function seedPlace(db: Database, id: string, tripId: string | null): Promise<void> {
  const now = '2026-05-10T10:00:00.000Z';
  await db.runAsync(
    `INSERT INTO places (id, trip_id, name, city, normalized_key,
                         enrichment_status, owner_id, created_at, updated_at)
     VALUES (?, ?, 'Place ' || ?, 'Tokyo', 'p-' || ?, 'pending', ?, ?, ?)`,
    id,
    tripId,
    id,
    id,
    ownerId,
    now,
    now,
  );
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

  it('listTrips orders alphabetically case-insensitive', async () => {
    const db = await freshDb();
    await createTrip(db, { id: 't1', name: 'iceland', ownerId });
    await createTrip(db, { id: 't2', name: 'Brazil', ownerId });
    await createTrip(db, { id: 't3', name: 'argentina', ownerId });
    const rows = await listTrips(db);
    expect(rows.map((r) => r.name)).toEqual(['argentina', 'Brazil', 'iceland']);
  });

  it('getTrip returns the trip; null for missing or deleted', async () => {
    const db = await freshDb();
    await createTrip(db, { id: 't1', name: 'Japan', ownerId });
    expect((await getTrip(db, 't1'))?.name).toBe('Japan');
    expect(await getTrip(db, 'missing')).toBeNull();

    await deleteTrip(db, 't1');
    expect(await getTrip(db, 't1')).toBeNull();
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

  describe('deleteTrip — untriage (default)', () => {
    it('clears trip_id on member sources and places, removes the trip row', async () => {
      const db = await freshDb();
      await createTrip(db, { id: 't1', name: 'Japan', ownerId });
      await insertSource(db, {
        id: 's1',
        tripId: 't1',
        filePath: '/x/s1.jpg',
        contentHash: 'h-s1',
        origin: 'manual',
        capturedAt: '2026-05-10T10:00:00Z',
        ownerId,
      });
      await seedPlace(db, 'p1', 't1');

      await deleteTrip(db, 't1');

      expect(await listTrips(db)).toEqual([]);
      const inbox = await listSources(db, { tripId: null });
      expect(inbox.map((r) => r.id)).toEqual(['s1']);
      const placeRow = await db.getFirstAsync<{ trip_id: string | null }>(
        `SELECT trip_id FROM places WHERE id = 'p1'`,
      );
      expect(placeRow?.trip_id).toBeNull();
    });

    it('explicit mode argument behaves the same as default', async () => {
      const db = await freshDb();
      await createTrip(db, { id: 't1', name: 'Japan', ownerId });
      await deleteTrip(db, 't1', 'untriage');
      expect(await getTrip(db, 't1')).toBeNull();
    });
  });

  describe('deleteTrip — cascade', () => {
    it('removes the trip, all member sources, their files, places, and junctions', async () => {
      const db = await freshDb();
      const deletedFiles: string[] = [];
      const fakeUnlink = (path: string) => deletedFiles.push(path);

      await createTrip(db, { id: 't1', name: 'Japan', ownerId });
      await insertSource(db, {
        id: 's1',
        tripId: 't1',
        filePath: '/x/s1.jpg',
        contentHash: 'h-s1',
        origin: 'manual',
        capturedAt: '2026-05-10T10:00:00Z',
        ownerId,
      });
      await insertSource(db, {
        id: 's2',
        tripId: 't1',
        filePath: '/x/s2.jpg',
        contentHash: 'h-s2',
        origin: 'manual',
        capturedAt: '2026-05-10T10:00:01Z',
        ownerId,
      });
      await seedPlace(db, 'p1', 't1');
      await seedPlace(db, 'p2', 't1');
      await linkPlaceSource(db, {
        placeId: 'p1',
        sourceId: 's1',
        extractionModel: 'gemini',
        ownerId,
      });
      await linkPlaceSource(db, {
        placeId: 'p2',
        sourceId: 's2',
        extractionModel: 'gemini',
        ownerId,
      });

      await deleteTrip(db, 't1', 'cascade', { unlinkFile: fakeUnlink });

      expect(await getTrip(db, 't1')).toBeNull();
      const sources = await db.getAllAsync<{ id: string }>(
        `SELECT id FROM sources WHERE id IN ('s1', 's2')`,
      );
      expect(sources).toEqual([]);
      const places = await db.getAllAsync<{ id: string }>(
        `SELECT id FROM places WHERE id IN ('p1', 'p2')`,
      );
      expect(places).toEqual([]);
      const junctions = await db.getAllAsync<{ source_id: string }>(
        `SELECT source_id FROM place_sources WHERE source_id IN ('s1', 's2')`,
      );
      expect(junctions).toEqual([]);
      expect(deletedFiles.sort()).toEqual(['/x/s1.jpg', '/x/s2.jpg']);
    });

    it('preserves a place shared with another trip; clears its trip_id only', async () => {
      const db = await freshDb();
      await createTrip(db, { id: 'tA', name: 'Japan', ownerId });
      await createTrip(db, { id: 'tB', name: 'Korea', ownerId });
      // pShared has two sources: sA in trip tA, sB in trip tB.
      await insertSource(db, {
        id: 'sA',
        tripId: 'tA',
        filePath: '/x/sA.jpg',
        contentHash: 'h-A',
        origin: 'manual',
        capturedAt: '2026-05-10T10:00:00Z',
        ownerId,
      });
      await insertSource(db, {
        id: 'sB',
        tripId: 'tB',
        filePath: '/x/sB.jpg',
        contentHash: 'h-B',
        origin: 'manual',
        capturedAt: '2026-05-10T10:00:01Z',
        ownerId,
      });
      await seedPlace(db, 'pShared', 'tA');
      await linkPlaceSource(db, {
        placeId: 'pShared',
        sourceId: 'sA',
        extractionModel: 'gemini',
        ownerId,
      });
      await linkPlaceSource(db, {
        placeId: 'pShared',
        sourceId: 'sB',
        extractionModel: 'gemini',
        ownerId,
      });

      await deleteTrip(db, 'tA', 'cascade', { unlinkFile: () => {} });

      // pShared survives because sB still backs it.
      const place = await db.getFirstAsync<{ trip_id: string | null }>(
        `SELECT trip_id FROM places WHERE id = 'pShared'`,
      );
      expect(place).toBeTruthy();
      expect(place?.trip_id).toBeNull(); // defensive untriage
      // sB and tB untouched.
      const sB = await db.getFirstAsync<{ trip_id: string | null }>(
        `SELECT trip_id FROM sources WHERE id = 'sB'`,
      );
      expect(sB?.trip_id).toBe('tB');
      // sA gone, junction sA gone.
      expect(await db.getFirstAsync(`SELECT id FROM sources WHERE id = 'sA'`)).toBeNull();
      const sharedJunctions = await db.getAllAsync<{ source_id: string }>(
        `SELECT source_id FROM place_sources WHERE place_id = 'pShared'`,
      );
      expect(sharedJunctions.map((r) => r.source_id)).toEqual(['sB']);
    });
  });
});
