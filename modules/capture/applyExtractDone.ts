import * as Crypto from 'expo-crypto';
import type { Database } from '@/modules/storage/db';
import { notifyChange } from '@/modules/storage/live-query';
import {
  findSoleMatchByNormalizedKey,
  normalizePlaceKey,
} from '@/modules/storage/places';
import { linkPlaceSource } from '@/modules/storage/place_sources';
import type { ExtractedPlace } from '@/lib/extract/pollExtract';

export type ApplyExtractDoneInput = {
  sourceId: string;
  caption: string | null;
  coverPath: string | null;
  placesToInsert: ExtractedPlace[];
  model: string;
  ownerId: string;
  /** ISO timestamp. Caller-supplied so deterministic in tests. */
  now: string;
};

/**
 * Atomic "worker said done → write places + flip source state-machine"
 * step. Mirrors the place-resolve + asymmetric-fill semantics inside
 * modules/extraction/extraction.ts so cross-source dedup behaves the
 * same whether places came from the new worker-driven path or the
 * legacy image-source path.
 *
 * The whole thing runs inside a single transaction so the source row
 * never flips to extraction_status='done' without its places landing.
 * UI queries that gate on extraction_status='done' will see the final
 * state atomically.
 */
export async function applyExtractDone(
  db: Database,
  input: ApplyExtractDoneInput,
): Promise<void> {
  await db.withTransactionAsync(async () => {
    // Read the source's current trip_id so newly-inserted places inherit
    // the user's suggested trip from share time.
    const source = await db.getFirstAsync<{ trip_id: string | null }>(
      `SELECT trip_id FROM sources WHERE id = ?`,
      input.sourceId,
    );
    const sourceTripId = source?.trip_id ?? null;

    for (const candidate of input.placesToInsert) {
      const normalizedKey = normalizePlaceKey(candidate.name, candidate.city);
      const countryCode = candidate.country_code === '' ? null : candidate.country_code;
      const placeId = await resolveOrInsertPlace(
        db,
        candidate,
        normalizedKey,
        countryCode,
        sourceTripId,
        input.ownerId,
        input.now,
      );
      await linkPlaceSource(db, {
        placeId,
        sourceId: input.sourceId,
        extractedAt: input.now,
        extractedAddress: candidate.address,
        extractionModel: input.model,
        ownerId: input.ownerId,
      });
    }

    await db.runAsync(
      `UPDATE sources
          SET extraction_status = 'done',
              ocr_status = 'done',
              caption = COALESCE(?, caption),
              file_path = COALESCE(?, file_path),
              updated_at = ?
        WHERE id = ?`,
      input.caption,
      input.coverPath,
      input.now,
      input.sourceId,
    );
  });
  notifyChange('sources');
  notifyChange('places');
  notifyChange('place_sources');
}

async function resolveOrInsertPlace(
  db: Database,
  candidate: ExtractedPlace,
  normalizedKey: string,
  countryCode: string | null,
  sourceTripId: string | null,
  ownerId: string,
  ts: string,
): Promise<string> {
  const existing = await findSoleMatchByNormalizedKey(db, normalizedKey, ownerId);
  if (existing) {
    // Re-attached source nudges a previously not-found place back to pending
    // so the user gets one more enrichment attempt against the new text.
    // Already-enriched places stay put.
    await db.runAsync(
      `UPDATE places
          SET enrichment_status = 'pending', updated_at = ?
        WHERE id = ? AND enrichment_status = 'not-found'`,
      ts,
      existing,
    );
    // Asymmetric fill: only fill NULL country_code, never overwrite. Stops
    // re-extractions with disagreeing LLM output from flapping the canonical
    // value (enrichment is authoritative once it lands).
    if (countryCode !== null) {
      await db.runAsync(
        `UPDATE places
            SET country_code = ?, updated_at = ?
          WHERE id = ? AND country_code IS NULL`,
        countryCode,
        ts,
        existing,
      );
    }
    return existing;
  }

  const newId = Crypto.randomUUID();
  await db.runAsync(
    `INSERT INTO places (
       id, trip_id, name, city, country_code, category, normalized_key,
       enrichment_status, owner_id, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
    newId,
    sourceTripId,
    candidate.name,
    candidate.city,
    countryCode,
    candidate.category,
    normalizedKey,
    ownerId,
    ts,
    ts,
  );
  return newId;
}
