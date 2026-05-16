import type { Database } from './db';
import { notifyChange } from './live-query';

export type SourceKind = 'image' | 'url' | 'pasted';
export type SourcePlatform = 'instagram' | 'tiktok';
export type SourceOrigin = 'share' | 'auto' | 'manual';
export type ProcessingStatus = 'pending' | 'done' | 'failed';

// Mirrors `modules/extraction/strategies/types.ts`. Stored as TEXT in
// `sources.extraction_strategy`; legacy rows have NULL and the orchestrator
// treats NULL as 'ocrTextLLM'. No DB CHECK constraint — boundary types here
// + Zod at the worker boundary are the enforcement.
export type ExtractionStrategyName =
  | 'ocrTextLLM'
  | 'vision'
  | 'captionPlusVision'
  | 'videoPlusCaption';

export type Source = {
  id: string;
  kind: SourceKind;
  platform: SourcePlatform | null;
  tripId: string | null;
  filePath: string | null;
  url: string | null;
  caption: string | null;
  contentHash: string;
  origin: SourceOrigin;
  ocrStatus: ProcessingStatus;
  ocrText: string | null;
  extractionStatus: ProcessingStatus;
  extractionPausedReason: string | null;
  urlFetchPausedReason: string | null;
  extractionStrategy: ExtractionStrategyName | null;
  fetchedVia: string | null;
  capturedAt: string;
  ownerId: string;
  createdAt: string;
  updatedAt: string;
};

export type InsertSourceInput = {
  id: string;
  kind?: SourceKind; // defaults to 'image'
  platform?: SourcePlatform | null;
  tripId: string | null;
  filePath?: string | null;
  url?: string | null;
  contentHash: string;
  origin: SourceOrigin;
  capturedAt: string;
  ownerId: string;
  extractionStrategy?: ExtractionStrategyName | null;
  // For image imports: a synthesized "Photo taken in X" hint derived from
  // EXIF GPS. For URL imports it stays null until applyUrlFetchResult writes
  // the IG/TikTok caption. Empty / whitespace-only strings are normalised
  // to NULL at insert time.
  caption?: string | null;
};

export async function insertSource(db: Database, input: InsertSourceInput): Promise<void> {
  const now = new Date().toISOString();
  const caption =
    typeof input.caption === 'string' && input.caption.trim().length > 0 ? input.caption : null;
  await db.runAsync(
    `INSERT INTO sources (
      id, kind, platform, trip_id, file_path, url, caption, content_hash, origin,
      ocr_status, extraction_status, extraction_strategy, captured_at,
      owner_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'pending', ?, ?, ?, ?, ?)`,
    input.id,
    input.kind ?? 'image',
    input.platform ?? null,
    input.tripId,
    input.filePath ?? null,
    input.url ?? null,
    caption,
    input.contentHash,
    input.origin,
    input.extractionStrategy ?? null,
    input.capturedAt,
    input.ownerId,
    now,
    now,
  );
}

/**
 * Set the strategy for a row after creation — used by URL-fetch completion to
 * stamp 'vision' or 'captionPlusVision' depending on whether the worker
 * returned a caption.
 */
export async function setExtractionStrategy(
  db: Database,
  sourceId: string,
  strategy: ExtractionStrategyName,
): Promise<void> {
  const now = new Date().toISOString();
  await db.runAsync(
    `UPDATE sources SET extraction_strategy = ?, updated_at = ? WHERE id = ?`,
    strategy,
    now,
    sourceId,
  );
}

/**
 * Set the winning fetcher name on a URL source after `/fetch-post` returns.
 * Telemetry only — no behavior depends on this field.
 */
export async function setFetchedVia(db: Database, sourceId: string, via: string): Promise<void> {
  const now = new Date().toISOString();
  await db.runAsync(
    `UPDATE sources SET fetched_via = ?, updated_at = ? WHERE id = ?`,
    via,
    now,
    sourceId,
  );
}

type Row = {
  id: string;
  kind: SourceKind;
  platform: SourcePlatform | null;
  trip_id: string | null;
  file_path: string | null;
  url: string | null;
  caption: string | null;
  content_hash: string;
  origin: SourceOrigin;
  ocr_status: ProcessingStatus;
  ocr_text: string | null;
  extraction_status: ProcessingStatus;
  extraction_paused_reason: string | null;
  url_fetch_paused_reason: string | null;
  extraction_strategy: ExtractionStrategyName | null;
  fetched_via: string | null;
  captured_at: string;
  owner_id: string;
  created_at: string;
  updated_at: string;
};

const ALL_COLUMNS =
  'id, kind, platform, trip_id, file_path, url, caption, content_hash, origin, ocr_status, ocr_text, extraction_status, extraction_paused_reason, url_fetch_paused_reason, extraction_strategy, fetched_via, captured_at, owner_id, created_at, updated_at';

function rowToSource(r: Row): Source {
  return {
    id: r.id,
    kind: r.kind,
    platform: r.platform,
    tripId: r.trip_id,
    filePath: r.file_path,
    url: r.url,
    caption: r.caption,
    contentHash: r.content_hash,
    origin: r.origin,
    ocrStatus: r.ocr_status,
    ocrText: r.ocr_text,
    extractionStatus: r.extraction_status,
    extractionPausedReason: r.extraction_paused_reason,
    urlFetchPausedReason: r.url_fetch_paused_reason,
    extractionStrategy: r.extraction_strategy,
    fetchedVia: r.fetched_via,
    capturedAt: r.captured_at,
    ownerId: r.owner_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function getSource(db: Database, id: string): Promise<Source | null> {
  const row = await db.getFirstAsync<Row>(`SELECT ${ALL_COLUMNS} FROM sources WHERE id = ?`, id);
  return row ? rowToSource(row) : null;
}

export async function listSources(
  db: Database,
  filter: { tripId: string | null },
): Promise<Source[]> {
  const rows = await db.getAllAsync<Row>(
    `SELECT ${ALL_COLUMNS}
       FROM sources
      WHERE ((? IS NULL AND trip_id IS NULL) OR trip_id = ?)
   ORDER BY captured_at DESC`,
    filter.tripId,
    filter.tripId,
  );
  return rows.map(rowToSource);
}

export async function listAllSources(db: Database): Promise<Source[]> {
  const rows = await db.getAllAsync<Row>(
    `SELECT ${ALL_COLUMNS} FROM sources ORDER BY captured_at DESC`,
  );
  return rows.map(rowToSource);
}

export async function listInboxSources(db: Database): Promise<Source[]> {
  const rows = await db.getAllAsync<Row>(
    `SELECT ${ALL_COLUMNS}
       FROM sources
      WHERE trip_id IS NULL
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
                WHERE trip_id = ?
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
 *   1. its `place_sources` link to this source is hard-DELETEd, and
 *   2. the `places` row itself is hard-DELETEd IFF no `place_sources` link
 *      remains AND the place has no `trip_id`.
 *
 * The two-anchor rule ("keep alive while it has a source link OR a trip")
 * prevents accidental loss of a place that another source still references
 * or that a previous triage already committed into a trip.
 *
 * The carve-out (spec §3.5): we deliberately do NOT source-prune the source
 * being assigned — its links to non-excluded places stay, and dropping its
 * link to an excluded place never deletes the source itself.
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
  const excludeIds = tripId !== null ? (opts?.excludePlaceIds ?? []) : [];
  await db.withTransactionAsync(async () => {
    await db.runAsync(
      `UPDATE sources SET trip_id = ?, updated_at = ? WHERE id = ?`,
      tripId,
      now,
      sourceId,
    );

    for (const placeId of excludeIds) {
      await db.runAsync(
        `DELETE FROM place_sources WHERE source_id = ? AND place_id = ?`,
        sourceId,
        placeId,
      );
      const remaining = await db.getFirstAsync<{ n: number }>(
        `SELECT COUNT(*) AS n FROM place_sources WHERE place_id = ?`,
        placeId,
      );
      if ((remaining?.n ?? 0) === 0) {
        const result = await db.runAsync(
          `DELETE FROM places WHERE id = ? AND trip_id IS NULL`,
          placeId,
        );
        if (result.changes > 0) deletedPlaces = true;
      }
    }

    // Mirror movePlaceToTrip's cascade in the opposite direction: when a
    // source gets triaged into a trip, pull its untriaged extracted
    // places along with it. The cascade naturally skips places we just
    // hard-deleted and links we just hard-deleted (rows are gone).
    if (tripId !== null) {
      const result = await db.runAsync(
        `UPDATE places
            SET trip_id = ?, updated_at = ?
          WHERE trip_id IS NULL
            AND id IN (
              SELECT place_id FROM place_sources
               WHERE source_id = ?
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

/**
 * Apply the result of a successful worker `/fetch-post` call to a URL source.
 * `filePath` is the persistent local path of the downloaded cover image (null
 * when download was skipped or failed and we're falling back to caption-only).
 * `caption` is the og:description text, already entity-decoded.
 * When `extractionStrategy` is provided, it's stamped on the row atomically
 * (used by the composable-extraction pipeline so vision rows are committed
 * to a strategy in the same transaction as the fetch result).
 */
export async function applyUrlFetchResult(
  db: Database,
  sourceId: string,
  filePath: string | null,
  caption: string,
  extractionStrategy?: ExtractionStrategyName,
): Promise<void> {
  const now = new Date().toISOString();
  if (extractionStrategy !== undefined) {
    await db.runAsync(
      `UPDATE sources
          SET file_path = ?, caption = ?, extraction_strategy = ?, updated_at = ?
        WHERE id = ?`,
      filePath,
      caption,
      extractionStrategy,
      now,
      sourceId,
    );
  } else {
    await db.runAsync(
      `UPDATE sources
          SET file_path = ?, caption = ?, updated_at = ?
        WHERE id = ?`,
      filePath,
      caption,
      now,
      sourceId,
    );
  }
  notifyChange('sources');
}

export type DeleteSourceOptions = {
  unlinkFile?: (path: string) => void;
};

const defaultUnlink = (path: string): void => {
  try {
    new (require('expo-file-system').File)(path).delete();
  } catch (err) {
    console.warn('[deleteSource] unlink failed', path, err);
  }
};

export async function deleteSource(
  db: Database,
  id: string,
  opts: DeleteSourceOptions = {},
): Promise<void> {
  const unlink = opts.unlinkFile ?? defaultUnlink;
  let filePath: string | null = null;

  await db.withTransactionAsync(async () => {
    const placeRows = await db.getAllAsync<{ place_id: string }>(
      `SELECT place_id FROM place_sources WHERE source_id = ?`,
      id,
    );
    const affectedPlaceIds = placeRows.map((r) => r.place_id);

    const fileRow = await db.getFirstAsync<{ file_path: string | null }>(
      `SELECT file_path FROM sources WHERE id = ?`,
      id,
    );
    filePath = fileRow?.file_path ?? null;

    await db.runAsync(`DELETE FROM place_sources WHERE source_id = ?`, id);
    await db.runAsync(`DELETE FROM sources WHERE id = ?`, id);

    for (const placeId of affectedPlaceIds) {
      const remaining = await db.getFirstAsync<{ n: number }>(
        `SELECT COUNT(*) AS n FROM place_sources WHERE place_id = ?`,
        placeId,
      );
      if ((remaining?.n ?? 0) === 0) {
        await db.runAsync(`DELETE FROM places WHERE id = ?`, placeId);
      }
    }
  });

  if (filePath) unlink(filePath);

  notifyChange('sources');
  notifyChange('place_sources');
  notifyChange('places');
  notifyChange('trips');
}

export async function countSourcesByTrip(db: Database): Promise<Record<string, number>> {
  const rows = await db.getAllAsync<{ trip_id: string; n: number }>(
    `SELECT trip_id, COUNT(*) AS n
       FROM sources
      WHERE trip_id IS NOT NULL
   GROUP BY trip_id`,
  );
  const out: Record<string, number> = {};
  for (const r of rows) out[r.trip_id] = r.n;
  return out;
}
