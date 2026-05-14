import type { Database } from './db';
import { notifyChange } from './live-query';

export type PlaceSource = {
  placeId: string;
  sourceId: string;
  extractedAt: string;
  rawText: string | null;
  extractedAddress: string | null;
  confidence: number | null;
  extractionModel: string;
  ownerId: string;
  createdAt: string;
  updatedAt: string;
};

export type LinkPlaceSourceInput = {
  placeId: string;
  sourceId: string;
  rawText?: string | null;
  extractedAddress?: string | null;
  confidence?: number | null;
  extractionModel: string;
  ownerId: string;
  // optional override; defaults to "now"
  extractedAt?: string;
};

// Idempotent: same (placeId, sourceId) pair attaches once. ON CONFLICT
// DO NOTHING covers the "same source already attached to this place"
// case the enrichment merge can produce.
export async function linkPlaceSource(db: Database, input: LinkPlaceSourceInput): Promise<void> {
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO place_sources (
       place_id, source_id, extracted_at,
       raw_text, extracted_address, confidence, extraction_model,
       owner_id, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(place_id, source_id) DO NOTHING`,
    input.placeId,
    input.sourceId,
    input.extractedAt ?? now,
    input.rawText ?? null,
    input.extractedAddress ?? null,
    input.confidence ?? null,
    input.extractionModel,
    input.ownerId,
    now,
    now,
  );
  notifyChange('place_sources');
  notifyChange('places');
}

type Row = {
  place_id: string;
  source_id: string;
  extracted_at: string;
  raw_text: string | null;
  extracted_address: string | null;
  confidence: number | null;
  extraction_model: string;
  owner_id: string;
  created_at: string;
  updated_at: string;
};

const ALL = `place_id, source_id, extracted_at, raw_text, extracted_address,
   confidence, extraction_model, owner_id, created_at, updated_at`;

function rowToPlaceSource(r: Row): PlaceSource {
  return {
    placeId: r.place_id,
    sourceId: r.source_id,
    extractedAt: r.extracted_at,
    rawText: r.raw_text,
    extractedAddress: r.extracted_address,
    confidence: r.confidence,
    extractionModel: r.extraction_model,
    ownerId: r.owner_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function listSourcesForPlace(db: Database, placeId: string): Promise<PlaceSource[]> {
  const rows = await db.getAllAsync<Row>(
    `SELECT ${ALL}
       FROM place_sources
      WHERE place_id = ?
   ORDER BY extracted_at ASC`,
    placeId,
  );
  return rows.map(rowToPlaceSource);
}

export async function listPlacesForSource(db: Database, sourceId: string): Promise<PlaceSource[]> {
  const rows = await db.getAllAsync<Row>(
    `SELECT ${ALL}
       FROM place_sources
      WHERE source_id = ?
   ORDER BY extracted_at ASC`,
    sourceId,
  );
  return rows.map(rowToPlaceSource);
}

// For the enrichment merge: move all live junction rows from `loserId`
// to `winnerId`. ON CONFLICT(place_id, source_id) DO NOTHING handles the
// case where both sides already attach the same source — the winner's
// existing row stays.
export async function transferJunctions(
  db: Database,
  loserId: string,
  winnerId: string,
): Promise<void> {
  await db.runAsync(
    `INSERT INTO place_sources (
       place_id, source_id, extracted_at, raw_text, extracted_address,
       confidence, extraction_model, owner_id, created_at, updated_at
     )
     SELECT ?, source_id, extracted_at, raw_text, extracted_address,
            confidence, extraction_model, owner_id, created_at, updated_at
       FROM place_sources
      WHERE place_id = ?
     ON CONFLICT(place_id, source_id) DO NOTHING`,
    winnerId,
    loserId,
  );
  await db.runAsync(`DELETE FROM place_sources WHERE place_id = ?`, loserId);
  notifyChange('place_sources');
  notifyChange('places');
}

export async function countLiveSourcesForPlace(db: Database, placeId: string): Promise<number> {
  const row = await db.getFirstAsync<{ n: number }>(
    `SELECT COUNT(*) AS n FROM place_sources WHERE place_id = ?`,
    placeId,
  );
  return row?.n ?? 0;
}
