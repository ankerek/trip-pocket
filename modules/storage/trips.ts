import type { Database } from './db';
import { notifyChange } from './live-query';

export type Trip = {
  id: string;
  name: string;
  color: string | null;
  ownerId: string;
  createdAt: string;
  updatedAt: string;
};

export type InsertTripInput = {
  id: string;
  name: string;
  color?: string | null;
  ownerId: string;
};

export type UpdateTripNameInput = {
  id: string;
  name: string;
};

type Row = {
  id: string;
  name: string;
  color: string | null;
  owner_id: string;
  created_at: string;
  updated_at: string;
};

function rowToTrip(r: Row): Trip {
  return {
    id: r.id,
    name: r.name,
    color: r.color,
    ownerId: r.owner_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function createTrip(db: Database, input: InsertTripInput): Promise<void> {
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO trips (id, name, color, owner_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    input.id,
    input.name,
    input.color ?? null,
    input.ownerId,
    now,
    now,
  );
  notifyChange('trips');
}

export async function listTrips(db: Database): Promise<Trip[]> {
  const rows = await db.getAllAsync<Row>(
    `SELECT id, name, color, owner_id, created_at, updated_at
       FROM trips
   ORDER BY name COLLATE NOCASE ASC`,
  );
  return rows.map(rowToTrip);
}

export async function getTrip(db: Database, id: string): Promise<Trip | null> {
  const row = await db.getFirstAsync<Row>(
    `SELECT id, name, color, owner_id, created_at, updated_at
       FROM trips
      WHERE id = ?`,
    id,
  );
  return row ? rowToTrip(row) : null;
}

export async function renameTrip(db: Database, input: UpdateTripNameInput): Promise<void> {
  const now = new Date().toISOString();
  await db.runAsync(
    `UPDATE trips SET name = ?, updated_at = ? WHERE id = ?`,
    input.name,
    now,
    input.id,
  );
  notifyChange('trips');
}

export type DeleteTripMode = 'untriage' | 'cascade';

export type DeleteTripOptions = {
  /** Override the file-unlink primitive (used by tests to avoid touching disk). */
  unlinkFile?: (path: string) => void;
};

const defaultUnlink = (path: string): void => {
  try {
    new (require('expo-file-system').File)(path).delete();
  } catch (err) {
    console.warn('[deleteTrip] unlink failed', path, err);
  }
};

export async function deleteTrip(
  db: Database,
  id: string,
  mode: DeleteTripMode = 'untriage',
  opts: DeleteTripOptions = {},
): Promise<void> {
  const now = new Date().toISOString();
  const unlink = opts.unlinkFile ?? defaultUnlink;

  if (mode === 'untriage') {
    await db.withTransactionAsync(async () => {
      await db.runAsync(
        `UPDATE sources SET trip_id = NULL, updated_at = ? WHERE trip_id = ?`,
        now,
        id,
      );
      await db.runAsync(
        `UPDATE places SET trip_id = NULL, updated_at = ? WHERE trip_id = ?`,
        now,
        id,
      );
      await db.runAsync(`DELETE FROM trips WHERE id = ?`, id);
    });
    notifyChange('sources');
    notifyChange('places');
    notifyChange('trips');
    return;
  }

  // mode === 'cascade'
  let filePaths: string[] = [];
  await db.withTransactionAsync(async () => {
    const fileRows = await db.getAllAsync<{ file_path: string | null }>(
      `SELECT file_path FROM sources WHERE trip_id = ? AND file_path IS NOT NULL`,
      id,
    );
    filePaths = fileRows.map((r) => r.file_path).filter((p): p is string => p !== null);

    const affectedPlaceRows = await db.getAllAsync<{ place_id: string }>(
      `SELECT DISTINCT place_id FROM place_sources
        WHERE source_id IN (SELECT id FROM sources WHERE trip_id = ?)`,
      id,
    );
    const affectedPlaceIds = affectedPlaceRows.map((r) => r.place_id);

    // FK-leaf cleanup: tags first, then junctions, then orphan-prune places,
    // then defensive-untriage shared places, then the sources, then the trip.
    await db.runAsync(
      `DELETE FROM tags WHERE source_id IN (SELECT id FROM sources WHERE trip_id = ?)`,
      id,
    );
    await db.runAsync(
      `DELETE FROM place_sources WHERE source_id IN (SELECT id FROM sources WHERE trip_id = ?)`,
      id,
    );
    if (affectedPlaceIds.length > 0) {
      const placeholders = affectedPlaceIds.map(() => '?').join(',');
      await db.runAsync(
        `DELETE FROM places
          WHERE id IN (${placeholders})
            AND id NOT IN (SELECT place_id FROM place_sources)`,
        ...affectedPlaceIds,
      );
    }
    await db.runAsync(
      `UPDATE places SET trip_id = NULL, updated_at = ? WHERE trip_id = ?`,
      now,
      id,
    );
    await db.runAsync(`DELETE FROM sources WHERE trip_id = ?`, id);
    await db.runAsync(`DELETE FROM trips WHERE id = ?`, id);
  });

  for (const path of filePaths) unlink(path);

  notifyChange('place_sources');
  notifyChange('places');
  notifyChange('sources');
  notifyChange('trips');
}
