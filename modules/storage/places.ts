import type { Database } from './db';
import { notifyChange } from './live-query';

export type EnrichmentStatus = 'pending' | 'enriched' | 'not-found' | 'failed';

export type Place = {
  id: string;
  tripId: string | null;
  name: string;
  city: string | null;
  countryCode: string | null;
  category: string | null;
  normalizedKey: string;

  externalPlaceId: string | null;
  photoName: string | null;
  description: string | null;
  rating: number | null;
  priceLevel: number | null;
  externalUrl: string | null;
  latitude: number | null;
  longitude: number | null;
  formattedAddress: string | null;
  enrichmentStatus: EnrichmentStatus;
  enrichmentPausedReason: string | null;
  enrichedAt: string | null;
  enrichmentModel: string | null;

  ownerId: string;
  createdAt: string;
  updatedAt: string;
};

type Row = {
  id: string;
  trip_id: string | null;
  name: string;
  city: string | null;
  country_code: string | null;
  category: string | null;
  normalized_key: string;
  external_place_id: string | null;
  photo_name: string | null;
  description: string | null;
  rating: number | null;
  price_level: number | null;
  external_url: string | null;
  latitude: number | null;
  longitude: number | null;
  formatted_address: string | null;
  enrichment_status: EnrichmentStatus;
  enrichment_paused_reason: string | null;
  enriched_at: string | null;
  enrichment_model: string | null;
  owner_id: string;
  created_at: string;
  updated_at: string;
};

const ALL = `id, trip_id, name, city, country_code, category, normalized_key,
   external_place_id, photo_name, description, rating, price_level,
   external_url, latitude, longitude, formatted_address,
   enrichment_status, enrichment_paused_reason, enriched_at, enrichment_model,
   owner_id, created_at, updated_at`;

function rowToPlace(r: Row): Place {
  return {
    id: r.id,
    tripId: r.trip_id,
    name: r.name,
    city: r.city,
    countryCode: r.country_code,
    category: r.category,
    normalizedKey: r.normalized_key,
    externalPlaceId: r.external_place_id,
    photoName: r.photo_name,
    description: r.description,
    rating: r.rating,
    priceLevel: r.price_level,
    externalUrl: r.external_url,
    latitude: r.latitude,
    longitude: r.longitude,
    formattedAddress: r.formatted_address,
    enrichmentStatus: r.enrichment_status,
    enrichmentPausedReason: r.enrichment_paused_reason,
    enrichedAt: r.enriched_at,
    enrichmentModel: r.enrichment_model,
    ownerId: r.owner_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function normalizePlaceKey(name: string, city: string | null): string {
  return `${name.trim().toLowerCase()}|${(city ?? '').trim().toLowerCase()}`;
}

export type InsertPlaceInput = {
  id: string;
  tripId: string | null;
  name: string;
  city: string | null;
  /** ISO 3166-1 alpha-2 uppercase, or null when unknown. */
  countryCode?: string | null;
  category: string | null;
  ownerId: string;
};

export async function insertPlace(db: Database, input: InsertPlaceInput): Promise<Place> {
  const now = new Date().toISOString();
  const normalizedKey = normalizePlaceKey(input.name, input.city);
  await db.runAsync(
    `INSERT INTO places (
       id, trip_id, name, city, country_code, category, normalized_key,
       owner_id, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    input.id,
    input.tripId,
    input.name,
    input.city,
    input.countryCode ?? null,
    input.category,
    normalizedKey,
    input.ownerId,
    now,
    now,
  );
  notifyChange('places');
  notifyChange('trips');
  const row = await db.getFirstAsync<Row>(`SELECT ${ALL} FROM places WHERE id = ?`, input.id);
  return rowToPlace(row!);
}

export async function getPlace(db: Database, id: string): Promise<Place | null> {
  const row = await db.getFirstAsync<Row>(`SELECT ${ALL} FROM places WHERE id = ?`, id);
  return row ? rowToPlace(row) : null;
}

// Sole-match dedup. Returns the place id when exactly one live place
// matches the (normalized_key, owner_id) pair; null when zero or multiple
// match. Same-name chains (Starbucks-in-Tokyo) intentionally drop to null
// so the caller creates a new place rather than fabricating identity.
export async function findSoleMatchByNormalizedKey(
  db: Database,
  normalizedKey: string,
  ownerId: string,
): Promise<string | null> {
  const rows = await db.getAllAsync<{ id: string }>(
    `SELECT id FROM places
      WHERE normalized_key = ? AND owner_id = ?
      LIMIT 2`,
    normalizedKey,
    ownerId,
  );
  return rows.length === 1 ? rows[0]!.id : null;
}

export async function listPlaces(
  db: Database,
  filter?: { tripId?: string | null },
): Promise<Place[]> {
  if (filter && 'tripId' in filter) {
    const rows = await db.getAllAsync<Row>(
      `SELECT ${ALL}
         FROM places
        WHERE ((? IS NULL AND trip_id IS NULL) OR trip_id = ?)
     ORDER BY created_at DESC`,
      filter.tripId ?? null,
      filter.tripId ?? null,
    );
    return rows.map(rowToPlace);
  }
  const rows = await db.getAllAsync<Row>(`SELECT ${ALL} FROM places ORDER BY created_at DESC`);
  return rows.map(rowToPlace);
}

export async function movePlaceToTrip(
  db: Database,
  placeId: string,
  tripId: string | null,
): Promise<void> {
  const now = new Date().toISOString();
  let movedSources = false;
  await db.withTransactionAsync(async () => {
    await db.runAsync(
      `UPDATE places SET trip_id = ?, updated_at = ? WHERE id = ?`,
      tripId,
      now,
      placeId,
    );
    // Auto-pull untriaged sources into the trip with the place. Bound to
    // tripId !== null and source.trip_id IS NULL so we never yank a source
    // out of a trip the user explicitly placed it in, and never push sources
    // back to Inbox when the user just unassigned a place.
    if (tripId !== null) {
      const result = await db.runAsync(
        `UPDATE sources
            SET trip_id = ?, updated_at = ?
          WHERE trip_id IS NULL
            AND id IN (
              SELECT source_id FROM place_sources
               WHERE place_id = ?
            )`,
        tripId,
        now,
        placeId,
      );
      movedSources = result.changes > 0;
    }
  });
  notifyChange('places');
  notifyChange('trips');
  if (movedSources) notifyChange('sources');
}

export type DeletePlaceOptions = {
  unlinkFile?: (path: string) => void;
};

const defaultUnlink = (path: string): void => {
  try {
    new (require('expo-file-system').File)(path).delete();
  } catch (err) {
    console.warn('[deletePlace] unlink failed', path, err);
  }
};

export async function deletePlace(
  db: Database,
  id: string,
  opts: DeletePlaceOptions = {},
): Promise<void> {
  const unlink = opts.unlinkFile ?? defaultUnlink;
  const filesToUnlink: string[] = [];

  await db.withTransactionAsync(async () => {
    const sourceRows = await db.getAllAsync<{ source_id: string }>(
      `SELECT source_id FROM place_sources WHERE place_id = ?`,
      id,
    );
    const affectedSourceIds = sourceRows.map((r) => r.source_id);

    await db.runAsync(`DELETE FROM place_sources WHERE place_id = ?`, id);
    await db.runAsync(`DELETE FROM places WHERE id = ?`, id);

    for (const sourceId of affectedSourceIds) {
      const remaining = await db.getFirstAsync<{ n: number }>(
        `SELECT COUNT(*) AS n FROM place_sources WHERE source_id = ?`,
        sourceId,
      );
      if ((remaining?.n ?? 0) === 0) {
        const fileRow = await db.getFirstAsync<{ file_path: string | null }>(
          `SELECT file_path FROM sources WHERE id = ?`,
          sourceId,
        );
        await db.runAsync(`DELETE FROM tags WHERE source_id = ?`, sourceId);
        await db.runAsync(`DELETE FROM sources WHERE id = ?`, sourceId);
        if (fileRow?.file_path) filesToUnlink.push(fileRow.file_path);
      }
    }
  });

  for (const path of filesToUnlink) unlink(path);

  notifyChange('place_sources');
  notifyChange('places');
  notifyChange('sources');
  notifyChange('trips');
}

export type EnrichmentColumns = {
  externalPlaceId: string;
  photoName: string | null;
  description: string | null;
  rating: number | null;
  priceLevel: number | null;
  externalUrl: string | null;
  latitude: number | null;
  longitude: number | null;
  formattedAddress: string | null;
  enrichmentModel: string;
};

export async function applyEnrichment(
  db: Database,
  placeId: string,
  cols: EnrichmentColumns,
): Promise<void> {
  const now = new Date().toISOString();
  await db.runAsync(
    `UPDATE places
        SET external_place_id = ?, photo_name = ?, description = ?,
            rating = ?, price_level = ?, external_url = ?,
            latitude = ?, longitude = ?, formatted_address = ?,
            enrichment_status = 'enriched', enriched_at = ?,
            enrichment_model = ?, updated_at = ?
      WHERE id = ?`,
    cols.externalPlaceId,
    cols.photoName,
    cols.description,
    cols.rating,
    cols.priceLevel,
    cols.externalUrl,
    cols.latitude,
    cols.longitude,
    cols.formattedAddress,
    now,
    cols.enrichmentModel,
    now,
    placeId,
  );
  notifyChange('places');
}

export async function setEnrichmentStatus(
  db: Database,
  placeId: string,
  status: EnrichmentStatus,
): Promise<void> {
  const now = new Date().toISOString();
  await db.runAsync(
    `UPDATE places SET enrichment_status = ?, updated_at = ? WHERE id = ?`,
    status,
    now,
    placeId,
  );
  notifyChange('places');
}

// Returns the live place owned by `ownerId` whose external_place_id
// matches, excluding `excludingPlaceId`. Used by the enrichment merge
// to detect the canonical-collision case.
export async function findCollidingByExternalId(
  db: Database,
  externalPlaceId: string,
  ownerId: string,
  excludingPlaceId: string,
): Promise<Place | null> {
  const row = await db.getFirstAsync<Row>(
    `SELECT ${ALL}
       FROM places
      WHERE external_place_id = ? AND owner_id = ? AND id != ?
      LIMIT 1`,
    externalPlaceId,
    ownerId,
    excludingPlaceId,
  );
  return row ? rowToPlace(row) : null;
}

export async function countPlacesByTrip(db: Database): Promise<Record<string, number>> {
  const rows = await db.getAllAsync<{ trip_id: string; n: number }>(
    `SELECT trip_id, COUNT(*) AS n
       FROM places
      WHERE trip_id IS NOT NULL
   GROUP BY trip_id`,
  );
  const out: Record<string, number> = {};
  for (const r of rows) out[r.trip_id] = r.n;
  return out;
}
