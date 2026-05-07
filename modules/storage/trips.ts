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
  deleted_at: string | null;
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
    `SELECT id, name, color, owner_id, created_at, updated_at, deleted_at
       FROM trips
      WHERE deleted_at IS NULL
   ORDER BY name COLLATE NOCASE ASC`,
  );
  return rows.map(rowToTrip);
}

export async function getTrip(db: Database, id: string): Promise<Trip | null> {
  const row = await db.getFirstAsync<Row>(
    `SELECT id, name, color, owner_id, created_at, updated_at, deleted_at
       FROM trips
      WHERE id = ? AND deleted_at IS NULL`,
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

export async function softDeleteTrip(db: Database, id: string): Promise<void> {
  const now = new Date().toISOString();
  await db.withTransactionAsync(async () => {
    await db.runAsync(
      `UPDATE screenshots
          SET trip_id = NULL, updated_at = ?
        WHERE trip_id = ? AND deleted_at IS NULL`,
      now,
      id,
    );
    await db.runAsync(
      `UPDATE trips SET deleted_at = ?, updated_at = ? WHERE id = ?`,
      now,
      now,
      id,
    );
  });
  notifyChange('screenshots');
  notifyChange('trips');
}
