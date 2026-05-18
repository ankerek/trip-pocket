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
 * For URL sources, the worker now ships ENRICHED places (Option B):
 * each place may carry external_place_id, formatted_address, photo_name,
 * blurb, etc. When the worker matched Google Places, we insert with
 * enrichment_status='enriched' so the lazy client-side enricher never
 * fires for these. When the worker didn't match (`blurb_status='not-found'`),
 * we insert with enrichment_status='not-found'.
 *
 * The whole thing runs inside a single transaction so the source row
 * never flips to extraction_status='done' without its places landing.
 */
export async function applyExtractDone(
  db: Database,
  input: ApplyExtractDoneInput,
): Promise<void> {
  await db.withTransactionAsync(async () => {
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
        input.model,
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
  model: string,
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

  // If the worker shipped Google-Places-enriched data with the place,
  // insert the row already in 'enriched' state so the client enricher
  // never fires for it. When the worker matched a place_id (success or
  // failed bulk-blurb) we still mark it 'enriched' — failed blurbs leave
  // `description` null but the rest of the enrichment data is sound.
  // 'not-found' means Google didn't match; the row goes in as such so
  // the UI can surface the place without enrichment data instead of
  // showing a skeleton forever.
  const externalPlaceId = candidate.external_place_id ?? null;
  const blurbStatus = candidate.blurb_status ?? null;
  const enrichmentStatus =
    externalPlaceId !== null
      ? 'enriched'
      : blurbStatus === 'not-found'
        ? 'not-found'
        : 'pending';

  // Use the worker's authoritative display_name when present (Google's
  // displayName is canonical — e.g. "Tartine Bakery" rather than the
  // LLM-extracted "Tartine"). Falls back to the LLM name when null.
  const displayName = candidate.display_name?.trim() || candidate.name;

  await db.runAsync(
    `INSERT INTO places (
       id, trip_id, name, city, country_code, category, normalized_key,
       enrichment_status, owner_id, created_at, updated_at,
       external_place_id, photo_name, description,
       rating, price_level, external_url,
       latitude, longitude, formatted_address,
       enriched_at, enrichment_model
     ) VALUES (
       ?, ?, ?, ?, ?, ?, ?,
       ?, ?, ?, ?,
       ?, ?, ?,
       ?, ?, ?,
       ?, ?, ?,
       ?, ?
     )`,
    newId,
    sourceTripId,
    displayName,
    candidate.city,
    countryCode,
    candidate.category,
    normalizePlaceKey(displayName, candidate.city),
    enrichmentStatus,
    ownerId,
    ts,
    ts,
    externalPlaceId,
    candidate.photo_name ?? null,
    candidate.blurb ?? null,
    candidate.rating ?? null,
    candidate.price_level ?? null,
    candidate.external_url ?? null,
    candidate.latitude ?? null,
    candidate.longitude ?? null,
    candidate.formatted_address ?? null,
    enrichmentStatus === 'enriched' ? ts : null,
    enrichmentStatus === 'enriched' ? model : null,
  );
  return newId;
}
