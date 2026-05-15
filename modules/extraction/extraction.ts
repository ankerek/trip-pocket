import type { Database } from '@/modules/storage';
import { notifyChange } from '@/modules/storage';
import { findSoleMatchByNormalizedKey, normalizePlaceKey } from '@/modules/storage/places';
import { linkPlaceSource } from '@/modules/storage/place_sources';
import { startStage, type Stage } from '@/modules/pipeline-log';

export type ExtractedPlaceInput = {
  name: string;
  city: string;
  // Street address from the OCR text, verbatim (or empty string when none).
  // Persisted on the place_sources junction row and used by /enrich as a hint.
  address: string;
  category: 'food' | 'drinks' | 'stays' | 'sights' | 'activities' | 'shops';
  // ISO 3166-1 alpha-2 uppercase, or empty when the LLM couldn't infer.
  // Empty normalises to NULL on the way into `places.country_code`. The
  // extractor implements asymmetric-fill on dedup-match: NULL columns get
  // filled with a new non-empty value, but a non-NULL value is never
  // overwritten by a re-extraction (only by enrichment from Google Places).
  country_code: string;
};

export type ExtractionResult = {
  places: ExtractedPlaceInput[];
  model: string;
};

export type ExtractionErrorKind =
  | { kind: 'permanent' } // 4xx (non-429, non-401) — immediate `failed`
  | { kind: 'retryable' } // 5xx, timeout, TLS — counts toward 3-try budget
  | { kind: 'deferred'; retryAfterMs: number } // 429 — re-enqueue, do NOT count toward budget
  | { kind: 'entitlement-required' }; // 401 — paused until entitlement is active

export class ExtractionError extends Error {
  constructor(
    message: string,
    public readonly classification: ExtractionErrorKind,
  ) {
    super(message);
    this.name = 'ExtractionError';
  }
}

export type ExtractionRunner = (ocrText: string) => Promise<ExtractionResult>;

export type Extractor = {
  enqueueExtraction(sourceId: string): void;
  runExtractionSweep(): Promise<void>;
  runStartupRecovery(): Promise<void>;
  /**
   * Clears entitlement-paused rows and re-sweeps; call when entitlement becomes
   * active. Returns the number of rows that were unpaused so callers can
   * decide whether to surface a "Resuming your imports…" toast.
   */
  resumeEntitlementPaused(): Promise<number>;
  /** Test-only. Resolves once the in-memory queue has fully drained. */
  _awaitIdle(): Promise<void>;
};

export type CreateExtractorOptions = {
  db: Database;
  extract: ExtractionRunner;
  ownerId: string;
  maxRetries?: number;
  setTimer?: (cb: () => void, ms: number) => unknown;
  uuid?: () => string;
  now?: () => string;
};

type ProcessOutcome =
  | { kind: 'done' }
  | { kind: 'retry' }
  | { kind: 'deferred'; retryAfterMs: number };

export function createExtractor(opts: CreateExtractorOptions): Extractor {
  const maxRetries = opts.maxRetries ?? 3;
  const getNow = opts.now ?? (() => new Date().toISOString());
  const setTimer = opts.setTimer ?? ((cb: () => void, ms: number) => globalThis.setTimeout(cb, ms));
  const uuid = opts.uuid ?? defaultUuid;

  let chain: Promise<void> = Promise.resolve();
  const inflight = new Set<string>();
  const retryCount = new Map<string, number>();

  function enqueueExtraction(id: string): void {
    if (inflight.has(id)) return;
    inflight.add(id);
    appendToChain(id);
  }

  function appendToChain(id: string): void {
    chain = chain.then(async () => {
      const outcome = await processOne(id);
      if (outcome.kind === 'retry') {
        appendToChain(id);
        return;
      }
      if (outcome.kind === 'deferred') {
        setTimer(() => {
          appendToChain(id);
        }, outcome.retryAfterMs);
        return;
      }
      inflight.delete(id);
      retryCount.delete(id);
    });
  }

  async function processOne(id: string): Promise<ProcessOutcome> {
    const row = await opts.db.getFirstAsync<{ ocr_text: string | null; trip_id: string | null }>(
      `SELECT ocr_text, trip_id FROM sources WHERE id = ?`,
      id,
    );
    if (!row) return { kind: 'done' };

    const ocrText = (row.ocr_text ?? '').trim();
    if (!ocrText) {
      // Empty-OCR short-circuit: classifier signal of "noise". No proxy call.
      const ts = getNow();
      await opts.db.runAsync(
        `UPDATE sources
            SET extraction_status = 'done', updated_at = ?
          WHERE id = ?`,
        ts,
        id,
      );
      notifyChange('sources');
      return { kind: 'done' };
    }

    const stage = startStage('extraction', id);
    let result: ExtractionResult;
    try {
      result = await opts.extract(ocrText);
    } catch (err) {
      const classification =
        err instanceof ExtractionError ? err.classification : ({ kind: 'retryable' } as const);
      return classifyFailure(id, classification, err, stage);
    }

    // Per-call dedup: drop case-insensitive name + trimmed-city + trimmed-address
    // duplicates before any DB work. LLMs occasionally repeat in list mode.
    const seen = new Set<string>();
    const distinct = result.places.filter((p) => {
      const key = `${p.name.toLowerCase()}::${p.city.trim().toLowerCase()}::${p.address.trim().toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const ts = getNow();
    try {
      await opts.db.withTransactionAsync(async () => {
        for (const candidate of distinct) {
          const normalizedKey = normalizePlaceKey(candidate.name, candidate.city);
          const placeId = await resolvePlaceId(candidate, normalizedKey, row.trip_id, ts);
          await linkPlaceSource(opts.db, {
            placeId,
            sourceId: id,
            extractedAt: ts,
            extractedAddress: candidate.address,
            extractionModel: result.model,
            ownerId: opts.ownerId,
          });
        }
        await opts.db.runAsync(
          `UPDATE sources
              SET extraction_status = 'done', updated_at = ?
            WHERE id = ?`,
          ts,
          id,
        );
      });
    } catch (err) {
      // FK violation (source hard-deleted between load and insert) is permanent;
      // anything else is treated as retryable.
      const isPermanent = String(err).includes('FOREIGN KEY');
      return classifyFailure(
        id,
        isPermanent ? { kind: 'permanent' } : { kind: 'retryable' },
        err,
        stage,
      );
    }

    notifyChange('places');
    notifyChange('place_sources');
    notifyChange('sources');
    stage.done({
      placesCount: distinct.length,
      placesJson: JSON.stringify(distinct),
      model: result.model,
    });
    return { kind: 'done' };
  }

  // Sole-match dedup against existing places. Returns the existing place id if
  // exactly one live match by (normalized_key, owner_id); otherwise inserts a
  // new place and returns its id. New places inherit trip_id from the source.
  async function resolvePlaceId(
    candidate: ExtractedPlaceInput,
    normalizedKey: string,
    sourceTripId: string | null,
    ts: string,
  ): Promise<string> {
    // Normalise the LLM's empty-string sentinel to NULL at the storage boundary
    // so SQL has one canonical "unknown" representation.
    const countryCode = candidate.country_code === '' ? null : candidate.country_code;

    const existing = await findSoleMatchByNormalizedKey(opts.db, normalizedKey, opts.ownerId);
    if (existing) {
      // Spec: a re-attached source nudges a previously 'not-found' place back
      // to 'pending' so the user gets one more enrichment attempt with the new
      // raw_text. Already-enriched places stay enriched.
      await opts.db.runAsync(
        `UPDATE places
            SET enrichment_status = 'pending', updated_at = ?
          WHERE id = ? AND enrichment_status = 'not-found'`,
        ts,
        existing,
      );
      // Asymmetric fill: only fill NULL country_code, never overwrite a value.
      // The non-overwrite case is what stops re-extractions with disagreeing
      // LLM output from flapping the canonical value.
      if (countryCode !== null) {
        await opts.db.runAsync(
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

    const newId = uuid();
    await opts.db.runAsync(
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
      opts.ownerId,
      ts,
      ts,
    );
    return newId;
  }

  function classifyFailure(
    id: string,
    classification: ExtractionErrorKind,
    err: unknown,
    stage: Stage,
  ): ProcessOutcome {
    // Paused rows are not failures — skip stage emission so diagnostics stay clean.
    if (classification.kind === 'entitlement-required') {
      void markPaused(id);
      return { kind: 'done' };
    }
    // Every classifyFailure invocation ends *this attempt*. A retry/deferred
    // outcome creates a fresh stage in the next processOne call, so emitting
    // failed here gives the per-attempt rows the diagnostics stream wants.
    stage.failed(err);
    if (classification.kind === 'deferred') {
      return { kind: 'deferred', retryAfterMs: classification.retryAfterMs };
    }
    if (classification.kind === 'permanent') {
      void markFailed(id);
      return { kind: 'done' };
    }
    const next = (retryCount.get(id) ?? 0) + 1;
    retryCount.set(id, next);
    if (next < maxRetries) return { kind: 'retry' };
    void markFailed(id);
    return { kind: 'done' };
  }

  async function markFailed(id: string): Promise<void> {
    await opts.db.runAsync(
      `UPDATE sources
          SET extraction_status = 'failed', updated_at = ?
        WHERE id = ?`,
      getNow(),
      id,
    );
    notifyChange('sources');
  }

  async function markPaused(id: string): Promise<void> {
    await opts.db.runAsync(
      `UPDATE sources
          SET extraction_paused_reason = 'entitlement', updated_at = ?
        WHERE id = ?`,
      getNow(),
      id,
    );
    notifyChange('sources');
  }

  async function runExtractionSweep(): Promise<void> {
    // Mid-session sweeps deliberately skip 'failed' rows; the retry-on-relaunch
    // path is runStartupRecovery (called once per process). Paused rows are
    // skipped here and only re-entered via resumeEntitlementPaused.
    const rows = await opts.db.getAllAsync<{ id: string }>(
      `SELECT id FROM sources
        WHERE extraction_status = 'pending'
          AND ocr_status = 'done'
          AND extraction_paused_reason IS NULL
     ORDER BY captured_at ASC`,
    );
    for (const r of rows) enqueueExtraction(r.id);
  }

  async function runStartupRecovery(): Promise<void> {
    // Paused rows stay paused across restarts; only non-paused failures are reset.
    await opts.db.runAsync(
      `UPDATE sources
          SET extraction_status = 'pending', updated_at = ?
        WHERE extraction_status = 'failed'
          AND extraction_paused_reason IS NULL`,
      getNow(),
    );
  }

  async function resumeEntitlementPaused(): Promise<number> {
    const result = await opts.db.runAsync(
      `UPDATE sources
          SET extraction_paused_reason = NULL, updated_at = ?
        WHERE extraction_paused_reason = 'entitlement'`,
      getNow(),
    );
    if (result.changes > 0) notifyChange('sources');
    await runExtractionSweep();
    return result.changes;
  }

  async function _awaitIdle(): Promise<void> {
    while (true) {
      const before = chain;
      await before;
      if (chain === before) return;
    }
  }

  return {
    enqueueExtraction,
    runExtractionSweep,
    runStartupRecovery,
    resumeEntitlementPaused,
    _awaitIdle,
  };
}

function defaultUuid(): string {
  return globalThis.crypto.randomUUID();
}
