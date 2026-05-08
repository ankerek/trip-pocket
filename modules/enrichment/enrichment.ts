import type { Database } from '@/modules/storage';
import { notifyChange } from '@/modules/storage';
import { findCollidingByExternalId } from '@/modules/storage/places';
import { transferJunctions } from '@/modules/storage/place_sources';

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
      model: string;
    }
  | { kind: 'not-found' };

export type EnrichRequestPayload = {
  place_id: string;
  name: string;
  city: string;
  address: string | null;
  ocr_caption: string;
};

export type EnrichErrorKind = 'permanent' | 'retryable' | 'rate-limited';

export class EnrichmentError extends Error {
  constructor(message: string, public readonly classification: EnrichErrorKind) {
    super(message);
    this.name = 'EnrichmentError';
  }
}

export type EnrichmentRunner = (
  payload: EnrichRequestPayload,
) => Promise<EnrichOutcome>;

export type Enricher = {
  enqueueEnrichment(placeId: string): void;
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
  // Most recent non-null hint from place_sources.
  address: string | null;
  // Most recent non-null OCR text from any attached source.
  ocr_caption: string;
  created_at: string;
};

export function createEnricher(opts: CreateEnricherOptions): Enricher {
  const getNow = opts.now ?? (() => new Date().toISOString());

  // Per-place-id dedup. Cleared once a row settles.
  const inflightById = new Set<string>();
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
    if (place.enrichment_status === 'enriched' || place.enrichment_status === 'not-found') {
      return;
    }
    if (!place.ocr_caption || place.ocr_caption.trim().length === 0) {
      // Without an OCR caption the worker can't run the blurb step. Mark
      // 'not-found' rather than 'failed' so it doesn't retry on every open.
      await enqueueWrite(() => markNotFound(id));
      notifyChange('places');
      return;
    }

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
      await enqueueWrite(() => applyError(id));
      notifyChange('places');
      return;
    }

    await enqueueWrite(() => applyOutcome(place, outcome as EnrichOutcome));
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
      created_at: string;
    }>(
      `SELECT id, name, city, trip_id, enrichment_status, created_at
         FROM places WHERE id = ? AND deleted_at IS NULL`,
      id,
    );
    if (!place) return null;

    // Most-recent non-null extracted_address from this place's sources.
    const addrRow = await opts.db.getFirstAsync<{ extracted_address: string | null }>(
      `SELECT extracted_address
         FROM place_sources
        WHERE place_id = ? AND deleted_at IS NULL AND extracted_address IS NOT NULL
     ORDER BY extracted_at DESC
        LIMIT 1`,
      id,
    );

    // Most-recent non-empty ocr_text from this place's sources.
    const ocrRow = await opts.db.getFirstAsync<{ ocr_text: string | null }>(
      `SELECT s.ocr_text
         FROM place_sources ps
         JOIN sources s ON s.id = ps.source_id
        WHERE ps.place_id = ? AND ps.deleted_at IS NULL
          AND s.deleted_at IS NULL
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
      address: addrRow?.extracted_address ?? null,
      ocr_caption: ocrRow?.ocr_text ?? '',
      created_at: place.created_at,
    };
  }

  async function applyOutcome(
    place: PlaceSnapshot,
    outcome: EnrichOutcome,
  ): Promise<void> {
    if (outcome.kind === 'not-found') {
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
      place.trip_id === collision.tripId ||
      place.trip_id === null ||
      collision.tripId === null;

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

    const ts = getNow();
    await opts.db.withTransactionAsync(async () => {
      // Order matters: soft-delete the loser FIRST so the partial UNIQUE on
      // external_place_id doesn't fire when we promote the winner. Soft-deleted
      // rows are excluded from the UNIQUE index (WHERE deleted_at IS NULL).
      await opts.db.runAsync(
        `UPDATE places SET deleted_at = ?, updated_at = ? WHERE id = ?`,
        ts,
        ts,
        loserId,
      );

      // Move junction rows from loser → winner with PK conflict tolerance.
      await transferJunctions(opts.db, loserId, winnerId);

      // If winner is incoming (place), copy enrichment columns onto it.
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
    await opts.db.runAsync(
      `UPDATE places
          SET external_place_id = ?, photo_name = ?, description = ?,
              rating = ?, price_level = ?, external_url = ?,
              latitude = ?, longitude = ?, formatted_address = ?,
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

  async function _awaitIdle(): Promise<void> {
    while (pending.size > 0) {
      await Promise.allSettled(Array.from(pending));
    }
    // Drain any tail writes too.
    await writeChain;
  }

  return { enqueueEnrichment, _awaitIdle };
}
