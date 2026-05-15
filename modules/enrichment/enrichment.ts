import type { Database } from '@/modules/storage';
import { notifyChange } from '@/modules/storage';
import { findCollidingByExternalId } from '@/modules/storage/places';
import { transferJunctions } from '@/modules/storage/place_sources';
import { startStage } from '@/modules/pipeline-log';

// Optional debug echo from the worker (search/details/blurb sub-step
// outcomes). Lives in modules/enrichment/proxy.ts so the schema is the
// source of truth; re-typed loosely here to avoid a circular import.
export type EnrichDebugEcho = {
  searchOutcome: string;
  detailsOutcome: string;
  blurbOutcome: string;
};

// /enrich response, mirrors the worker's enrichResponseSchema.
export type EnrichOutcome =
  | {
      kind: 'enriched';
      external_place_id: string;
      latitude: number | null;
      longitude: number | null;
      formatted_address: string | null;
      photo_name: string | null;
      description: string | null;
      rating: number | null;
      price_level: number | null;
      external_url: string | null;
      // Authoritative geographic values from Google Places `addressComponents`.
      // Null when Google didn't supply the corresponding entry; the COALESCE
      // write path then preserves the LLM-extracted value.
      city: string | null;
      country_code: string | null;
      model: string;
      _debug?: EnrichDebugEcho;
    }
  | { kind: 'not-found'; _debug?: EnrichDebugEcho };

export type EnrichRequestPayload = {
  place_id: string;
  name: string;
  city: string;
  address: string | null;
  ocr_caption: string;
};

export type EnrichErrorKind = 'permanent' | 'retryable' | 'rate-limited' | 'entitlement-required';

export class EnrichmentError extends Error {
  constructor(
    message: string,
    public readonly classification: EnrichErrorKind,
  ) {
    super(message);
    this.name = 'EnrichmentError';
  }
}

export type EnrichmentRunner = (payload: EnrichRequestPayload) => Promise<EnrichOutcome>;

export type Enricher = {
  enqueueEnrichment(placeId: string): void;
  /**
   * Clears entitlement-paused places and re-enqueues them. Returns the number
   * of places that were unpaused (so the layout can show one combined
   * "Resuming…" toast across all pipeline modules).
   */
  resumeEntitlementPaused(): Promise<number>;
  /** Test-only. Resolves once all in-flight work has settled. */
  _awaitIdle(): Promise<void>;
};

export type CreateEnricherOptions = {
  db: Database;
  enrich: EnrichmentRunner;
  ownerId: string;
  /** Timestamp source. Default: () => new Date().toISOString(). Tests inject. */
  now?: () => string;
};

type PlaceSnapshot = {
  id: string;
  name: string;
  city: string;
  trip_id: string | null;
  enrichment_status: 'pending' | 'enriched' | 'not-found' | 'failed';
  enrichment_paused_reason: string | null;
  // Most recent non-null hint from place_sources.
  address: string | null;
  // Most recent non-null OCR text from any attached source.
  ocr_caption: string;
  // Loaded for the blurb-retry path: when a place is `enriched` but its
  // description is still null (Gemini failed the first time), processOne
  // re-runs /enrich rather than short-circuiting.
  description: string | null;
  created_at: string;
};

// Throttle window for the blurb-retry path: once we re-enrich an enriched
// place because its description was null, don't try again for 5 minutes even
// if the row stays null. Defends against list re-renders that would otherwise
// fire enqueueEnrichment on every component mount. Cleared on app restart —
// the next cold launch is itself a retry signal.
const BLURB_RETRY_THROTTLE_MS = 5 * 60 * 1000;

export function createEnricher(opts: CreateEnricherOptions): Enricher {
  const getNow = opts.now ?? (() => new Date().toISOString());

  // Per-place-id dedup. Cleared once a row settles.
  const inflightById = new Set<string>();
  // Per-instance throttle for the blurb-retry path; see BLURB_RETRY_THROTTLE_MS.
  // Lives on the enricher (not module-level) so test setups that build a fresh
  // enricher per case don't leak throttle state.
  const blurbRetryAt = new Map<string, number>();
  // Tracks every async operation we've kicked off; _awaitIdle() drains it.
  const pending = new Set<Promise<unknown>>();

  function track<T>(p: Promise<T>): Promise<T> {
    pending.add(p);
    p.finally(() => pending.delete(p));
    return p;
  }

  // Serialize DB writes. SQLite is single-writer, and our applyOutcome
  // wraps multiple statements in a transaction. Two concurrent applies
  // would crash on overlapping BEGINs.
  let writeChain: Promise<void> = Promise.resolve();
  function enqueueWrite(work: () => Promise<void>): Promise<void> {
    const next = writeChain.then(work);
    writeChain = next.catch(() => undefined);
    return next;
  }

  function enqueueEnrichment(id: string): void {
    if (inflightById.has(id)) return;
    inflightById.add(id);
    track(
      processOne(id).finally(() => {
        inflightById.delete(id);
      }),
    );
  }

  async function processOne(id: string): Promise<void> {
    const place = await loadPlace(id);
    if (!place) return;
    // Paused beats everything — a row paused for entitlement should not
    // proceed even if it was also already-enriched.
    if (place.enrichment_paused_reason === 'entitlement') return;
    if (place.enrichment_status === 'not-found') return;
    // 'enriched' is short-circuit by default, EXCEPT when description is
    // null — that means /enrich's first pass got Google Places data back
    // but the Gemini blurb failed. The blurb-retry path re-runs /enrich
    // once the in-memory throttle has elapsed.
    if (place.enrichment_status === 'enriched') {
      if (place.description !== null) return;
      const nextAllowed = blurbRetryAt.get(id) ?? 0;
      if (Date.now() < nextAllowed) return;
      blurbRetryAt.set(id, Date.now() + BLURB_RETRY_THROTTLE_MS);
    }
    if (!place.ocr_caption || place.ocr_caption.trim().length === 0) {
      // Without an OCR caption the worker can't run the blurb step. Mark
      // 'not-found' rather than 'failed' so it doesn't retry on every open.
      // Don't downgrade an already-enriched row though (blurb-retry path):
      // a missing caption shouldn't destroy real lat/lng/photo data.
      if (place.enrichment_status !== 'enriched') {
        await enqueueWrite(() => markNotFound(id));
        notifyChange('places');
      }
      return;
    }

    // Enrichment is logically per-place (one place ↔ N sources), but the
    // diagnostics stream groups by source_id. To keep the common "shared X
    // → see what happened" trace in one group, tag this stage with the
    // most-recently-attached source. For multi-source places the choice is
    // a heuristic; placeId stays in the firehose extras either way.
    const latestSrc = await opts.db.getFirstAsync<{ source_id: string }>(
      `SELECT source_id FROM place_sources
        WHERE place_id = ?
     ORDER BY extracted_at DESC
        LIMIT 1`,
      id,
    );
    const stage = startStage('enrichment', latestSrc?.source_id);
    let outcome: EnrichOutcome | EnrichmentError;
    try {
      outcome = await opts.enrich({
        place_id: place.id,
        name: place.name,
        city: place.city,
        address: place.address,
        ocr_caption: place.ocr_caption,
      });
    } catch (err) {
      outcome =
        err instanceof EnrichmentError ? err : new EnrichmentError(String(err), 'retryable');
    }

    if (outcome instanceof EnrichmentError) {
      stage.failed(outcome);
      if (outcome.classification === 'entitlement-required') {
        // Write paused-reason rather than 'failed' so the row is recoverable
        // once the user subscribes. Same "don't downgrade enriched" invariant
        // applies: a blurb-retry failure on an enriched row should not mark
        // it paused and lose the existing enrichment data.
        if (place.enrichment_status !== 'enriched') {
          await enqueueWrite(() => markEntitlementPaused(id));
          notifyChange('places');
        }
        return;
      }
      // Don't downgrade an already-enriched row to 'failed' on a retry —
      // a transient /enrich failure on the blurb-retry path shouldn't lose
      // the existing lat/lng/photo. The throttle map will gate further
      // attempts for 5 minutes.
      if (place.enrichment_status !== 'enriched') {
        await enqueueWrite(() => applyError(id));
        notifyChange('places');
      }
      return;
    }

    const enriched = outcome as EnrichOutcome;
    stage.done({
      placeId: place.id,
      kind: enriched.kind,
      hadPhoto: enriched.kind === 'enriched' ? Boolean(enriched.photo_name) : false,
      hadAddress: enriched.kind === 'enriched' ? Boolean(enriched.formatted_address) : false,
      hadRating: enriched.kind === 'enriched' ? enriched.rating !== null : false,
      // Spread the worker's _debug echo (search/details/blurb outcomes) so
      // the firehose surfaces sub-step degradation without `wrangler tail`.
      ...(enriched._debug ?? {}),
    });

    await enqueueWrite(() => applyOutcome(place, enriched));
    notifyChange('places');
    notifyChange('place_sources');
  }

  async function loadPlace(id: string): Promise<PlaceSnapshot | null> {
    const place = await opts.db.getFirstAsync<{
      id: string;
      name: string;
      city: string | null;
      trip_id: string | null;
      enrichment_status: PlaceSnapshot['enrichment_status'];
      enrichment_paused_reason: string | null;
      description: string | null;
      created_at: string;
    }>(
      `SELECT id, name, city, trip_id, enrichment_status, enrichment_paused_reason, description, created_at
         FROM places WHERE id = ?`,
      id,
    );
    if (!place) return null;

    // Most-recent non-null extracted_address from this place's sources.
    const addrRow = await opts.db.getFirstAsync<{ extracted_address: string | null }>(
      `SELECT extracted_address
         FROM place_sources
        WHERE place_id = ? AND extracted_address IS NOT NULL
     ORDER BY extracted_at DESC
        LIMIT 1`,
      id,
    );

    // Most-recent non-empty ocr_text from this place's sources.
    const ocrRow = await opts.db.getFirstAsync<{ ocr_text: string | null }>(
      `SELECT s.ocr_text
         FROM place_sources ps
         JOIN sources s ON s.id = ps.source_id
        WHERE ps.place_id = ?
          AND s.ocr_text IS NOT NULL AND TRIM(s.ocr_text) != ''
     ORDER BY ps.extracted_at DESC
        LIMIT 1`,
      id,
    );

    return {
      id: place.id,
      name: place.name,
      city: place.city ?? '',
      trip_id: place.trip_id,
      enrichment_status: place.enrichment_status,
      enrichment_paused_reason: place.enrichment_paused_reason,
      address: addrRow?.extracted_address ?? null,
      ocr_caption: ocrRow?.ocr_text ?? '',
      description: place.description,
      created_at: place.created_at,
    };
  }

  async function applyOutcome(place: PlaceSnapshot, outcome: EnrichOutcome): Promise<void> {
    if (outcome.kind === 'not-found') {
      // Don't downgrade an already-enriched row to 'not-found' just because
      // Google's index churned and a fresh search came back empty. The
      // blurb-retry path re-runs the full /enrich and could otherwise
      // destroy good enrichment data.
      if (place.enrichment_status === 'enriched') return;
      await markNotFound(place.id);
      return;
    }

    // Collision check: another live place already has this external_place_id?
    const collision = await findCollidingByExternalId(
      opts.db,
      outcome.external_place_id,
      opts.ownerId,
      place.id,
    );

    if (!collision) {
      await writeEnrichmentColumns(place.id, outcome);
      return;
    }

    // Trip-equality merge eligibility: equal trip_ids or one side NULL.
    const eligible =
      place.trip_id === collision.tripId || place.trip_id === null || collision.tripId === null;

    if (!eligible) {
      // Skip the merge: leave both places live, do not write external_place_id
      // on incoming (UNIQUE constraint forbids two live rows). Telemetry hook
      // is intentionally absent in this slice — see spec.
      return;
    }

    // Pick the winner: side with non-null trip wins; tie → older created_at.
    let winnerId: string;
    let loserId: string;
    if (collision.tripId !== null && place.trip_id === null) {
      winnerId = collision.id;
      loserId = place.id;
    } else if (collision.tripId === null && place.trip_id !== null) {
      winnerId = place.id;
      loserId = collision.id;
    } else {
      // Both null OR both set to the same trip. Older created_at wins.
      const winner = collision.createdAt <= place.created_at ? collision.id : place.id;
      winnerId = winner;
      loserId = winner === collision.id ? place.id : collision.id;
    }

    await opts.db.withTransactionAsync(async () => {
      // Order matters with hard-delete + non-partial UNIQUE on external_place_id:
      //   1. Re-home all loser junctions onto the winner.
      //   2. DELETE the loser place row (FK-safe now: junctions are on the winner).
      //   3. Promote winner with enrichment columns (external_place_id passes
      //      uniqueness because loser is physically gone).
      await transferJunctions(opts.db, loserId, winnerId);
      await opts.db.runAsync(`DELETE FROM places WHERE id = ?`, loserId);
      if (winnerId === place.id) {
        await writeEnrichmentColumns(place.id, outcome);
      }
    });
  }

  async function writeEnrichmentColumns(
    placeId: string,
    outcome: Extract<EnrichOutcome, { kind: 'enriched' }>,
  ): Promise<void> {
    const ts = getNow();
    // `city` and `country_code` use COALESCE(?, col) so a NULL from Google
    // never clobbers the LLM-extracted value. Non-null Google values are the
    // authoritative override (the whole point of dual-write).
    await opts.db.runAsync(
      `UPDATE places
          SET external_place_id = ?, photo_name = ?, description = ?,
              rating = ?, price_level = ?, external_url = ?,
              latitude = ?, longitude = ?, formatted_address = ?,
              city = COALESCE(?, city),
              country_code = COALESCE(?, country_code),
              enrichment_status = 'enriched', enriched_at = ?,
              enrichment_model = ?, updated_at = ?
        WHERE id = ?`,
      outcome.external_place_id,
      outcome.photo_name,
      outcome.description,
      outcome.rating,
      outcome.price_level,
      outcome.external_url,
      outcome.latitude,
      outcome.longitude,
      outcome.formatted_address,
      outcome.city,
      outcome.country_code,
      ts,
      outcome.model,
      ts,
      placeId,
    );
  }

  async function markNotFound(id: string): Promise<void> {
    const ts = getNow();
    await opts.db.runAsync(
      `UPDATE places
          SET enrichment_status = 'not-found', updated_at = ?
        WHERE id = ?`,
      ts,
      id,
    );
  }

  async function applyError(id: string): Promise<void> {
    // Retryable, rate-limited, and permanent all write 'failed'. The user
    // re-opening the card is the explicit retry signal — no automatic budget.
    const ts = getNow();
    await opts.db.runAsync(
      `UPDATE places
          SET enrichment_status = 'failed', updated_at = ?
        WHERE id = ?`,
      ts,
      id,
    );
  }

  async function markEntitlementPaused(id: string): Promise<void> {
    // Does NOT touch enrichment_status — the row stays 'pending' so that
    // resumeEntitlementPaused can simply clear the column and re-enqueue.
    const ts = getNow();
    await opts.db.runAsync(
      `UPDATE places
          SET enrichment_paused_reason = 'entitlement', updated_at = ?
        WHERE id = ?`,
      ts,
      id,
    );
  }

  async function resumeEntitlementPaused(): Promise<number> {
    const rows = await opts.db.getAllAsync<{ id: string }>(
      `SELECT id FROM places WHERE enrichment_paused_reason = 'entitlement'`,
    );
    if (rows.length === 0) return 0;
    const ts = getNow();
    await opts.db.runAsync(
      `UPDATE places SET enrichment_paused_reason = NULL, updated_at = ?
       WHERE enrichment_paused_reason = 'entitlement'`,
      ts,
    );
    notifyChange('places');
    for (const r of rows) enqueueEnrichment(r.id);
    return rows.length;
  }

  async function _awaitIdle(): Promise<void> {
    while (pending.size > 0) {
      await Promise.allSettled(Array.from(pending));
    }
    // Drain any tail writes too.
    await writeChain;
  }

  return { enqueueEnrichment, resumeEntitlementPaused, _awaitIdle };
}
