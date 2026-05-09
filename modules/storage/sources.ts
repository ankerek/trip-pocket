import type { Database } from './db';
import { notifyChange } from './live-query';

export type SourceKind = 'screenshot' | 'url' | 'pasted';
export type SourceOrigin = 'share' | 'auto' | 'manual';
export type ProcessingStatus = 'pending' | 'done' | 'failed';

export type Source = {
  id: string;
  kind: SourceKind;
  tripId: string | null;
  filePath: string | null;
  url: string | null;
  contentHash: string;
  origin: SourceOrigin;
  ocrStatus: ProcessingStatus;
  ocrText: string | null;
  extractionStatus: ProcessingStatus;
  capturedAt: string;
  ownerId: string;
  createdAt: string;
  updatedAt: string;
};

export type InsertSourceInput = {
  id: string;
  kind?: SourceKind; // defaults to 'screenshot'
  tripId: string | null;
  filePath?: string | null;
  url?: string | null;
  contentHash: string;
  origin: SourceOrigin;
  capturedAt: string;
  ownerId: string;
};

export async function insertSource(db: Database, input: InsertSourceInput): Promise<void> {
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO sources (
      id, kind, trip_id, file_path, url, content_hash, origin,
      ocr_status, extraction_status, captured_at,
      owner_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 'pending', ?, ?, ?, ?)`,
    input.id,
    input.kind ?? 'screenshot',
    input.tripId,
    input.filePath ?? null,
    input.url ?? null,
    input.contentHash,
    input.origin,
    input.capturedAt,
    input.ownerId,
    now,
    now,
  );
}

type Row = {
  id: string;
  kind: SourceKind;
  trip_id: string | null;
  file_path: string | null;
  url: string | null;
  content_hash: string;
  origin: SourceOrigin;
  ocr_status: ProcessingStatus;
  ocr_text: string | null;
  extraction_status: ProcessingStatus;
  captured_at: string;
  owner_id: string;
  created_at: string;
  updated_at: string;
};

const ALL_COLUMNS =
  'id, kind, trip_id, file_path, url, content_hash, origin, ocr_status, ocr_text, extraction_status, captured_at, owner_id, created_at, updated_at';

function rowToSource(r: Row): Source {
  return {
    id: r.id,
    kind: r.kind,
    tripId: r.trip_id,
    filePath: r.file_path,
    url: r.url,
    contentHash: r.content_hash,
    origin: r.origin,
    ocrStatus: r.ocr_status,
    ocrText: r.ocr_text,
    extractionStatus: r.extraction_status,
    capturedAt: r.captured_at,
    ownerId: r.owner_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function getSource(db: Database, id: string): Promise<Source | null> {
  const row = await db.getFirstAsync<Row>(
    `SELECT ${ALL_COLUMNS} FROM sources WHERE id = ? AND deleted_at IS NULL`,
    id,
  );
  return row ? rowToSource(row) : null;
}

export async function listSources(
  db: Database,
  filter: { tripId: string | null },
): Promise<Source[]> {
  const rows = await db.getAllAsync<Row>(
    `SELECT ${ALL_COLUMNS}
       FROM sources
      WHERE deleted_at IS NULL
        AND ((? IS NULL AND trip_id IS NULL) OR trip_id = ?)
   ORDER BY captured_at DESC`,
    filter.tripId,
    filter.tripId,
  );
  return rows.map(rowToSource);
}

export async function listAllSources(db: Database): Promise<Source[]> {
  const rows = await db.getAllAsync<Row>(
    `SELECT ${ALL_COLUMNS} FROM sources WHERE deleted_at IS NULL ORDER BY captured_at DESC`,
  );
  return rows.map(rowToSource);
}

export async function listInboxSources(db: Database): Promise<Source[]> {
  const rows = await db.getAllAsync<Row>(
    `SELECT ${ALL_COLUMNS}
       FROM sources
      WHERE deleted_at IS NULL AND trip_id IS NULL
   ORDER BY captured_at DESC`,
  );
  return rows.map(rowToSource);
}

export async function listSourcesByTrip(
  db: Database,
  tripId: string,
  limit?: number,
): Promise<Source[]> {
  const sql = `SELECT ${ALL_COLUMNS}
                 FROM sources
                WHERE deleted_at IS NULL AND trip_id = ?
             ORDER BY captured_at DESC
             ${limit !== undefined ? 'LIMIT ?' : ''}`;
  const rows =
    limit !== undefined
      ? await db.getAllAsync<Row>(sql, tripId, limit)
      : await db.getAllAsync<Row>(sql, tripId);
  return rows.map(rowToSource);
}

/**
 * Assigns a source to a trip (or back to the inbox when `tripId === null`)
 * and cascades the source's untriaged extracted places along with it.
 *
 * `opts.excludePlaceIds` is honored only when `tripId !== null` (committing
 * the source into a trip). For each excluded place:
 *   1. its `place_sources` link to this source is soft-deleted, and
 *   2. the `places` row itself is soft-deleted IFF no other live
 *      `place_sources` link remains AND the place has no `trip_id`.
 *
 * The two-anchor rule ("keep alive while it has a live source link OR a
 * trip") prevents accidental loss of a place that another source still
 * references or that a previous triage already committed into a trip.
 *
 * For `tripId === null`, `excludePlaceIds` is ignored — "Remove from trip"
 * is the inverse of triage, not a place-pruning operation.
 */
export async function assignSourceTrip(
  db: Database,
  sourceId: string,
  tripId: string | null,
  opts?: { excludePlaceIds?: string[] },
): Promise<void> {
  const now = new Date().toISOString();
  let movedPlaces = false;
  let deletedPlaces = false;
  const excludeIds = tripId !== null ? opts?.excludePlaceIds ?? [] : [];
  await db.withTransactionAsync(async () => {
    await db.runAsync(
      `UPDATE sources SET trip_id = ?, updated_at = ? WHERE id = ?`,
      tripId,
      now,
      sourceId,
    );

    for (const placeId of excludeIds) {
      await db.runAsync(
        `UPDATE place_sources
            SET deleted_at = ?, updated_at = ?
          WHERE source_id = ? AND place_id = ? AND deleted_at IS NULL`,
        now,
        now,
        sourceId,
        placeId,
      );
      const remaining = await db.getFirstAsync<{ n: number }>(
        `SELECT COUNT(*) AS n FROM place_sources
          WHERE place_id = ? AND deleted_at IS NULL`,
        placeId,
      );
      if ((remaining?.n ?? 0) === 0) {
        const result = await db.runAsync(
          `UPDATE places
              SET deleted_at = ?, updated_at = ?
            WHERE id = ? AND trip_id IS NULL AND deleted_at IS NULL`,
          now,
          now,
          placeId,
        );
        if (result.changes > 0) deletedPlaces = true;
      }
    }

    // Mirror movePlaceToTrip's cascade in the opposite direction: when a
    // source gets triaged into a trip, pull its untriaged extracted
    // places along with it. The cascade naturally skips places we just
    // soft-deleted and links we just soft-deleted (deleted_at IS NULL
    // filters on both).
    if (tripId !== null) {
      const result = await db.runAsync(
        `UPDATE places
            SET trip_id = ?, updated_at = ?
          WHERE trip_id IS NULL
            AND deleted_at IS NULL
            AND id IN (
              SELECT place_id FROM place_sources
               WHERE source_id = ? AND deleted_at IS NULL
            )`,
        tripId,
        now,
        sourceId,
      );
      movedPlaces = result.changes > 0;
    }
  });
  notifyChange('sources');
  if (movedPlaces || deletedPlaces) notifyChange('places');
  notifyChange('trips');
}

export async function softDeleteSource(db: Database, id: string): Promise<void> {
  const now = new Date().toISOString();
  await db.runAsync(
    `UPDATE sources SET deleted_at = ?, updated_at = ? WHERE id = ?`,
    now,
    now,
    id,
  );
  notifyChange('sources');
  notifyChange('trips');
}

export async function countSourcesByTrip(db: Database): Promise<Record<string, number>> {
  const rows = await db.getAllAsync<{ trip_id: string; n: number }>(
    `SELECT trip_id, COUNT(*) AS n
       FROM sources
      WHERE deleted_at IS NULL AND trip_id IS NOT NULL
   GROUP BY trip_id`,
  );
  const out: Record<string, number> = {};
  for (const r of rows) out[r.trip_id] = r.n;
  return out;
}
