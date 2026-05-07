import type { Database } from '@/modules/storage';
import { notifyChange } from '@/modules/storage';

export type ExtractedPlaceInput = {
  name: string;
  city: string;
  category: 'place' | 'food' | 'activity';
};

export type ExtractionResult = {
  places: ExtractedPlaceInput[];
  model: string;
};

export type GeocodeResult = {
  latitude: number;
  longitude: number;
  formattedAddress: string;
  appleMapsUrl: string;
};

export type ExtractionErrorKind =
  | { kind: 'permanent' }                       // 4xx (non-429) — immediate `failed`
  | { kind: 'retryable' }                       // 5xx, timeout, TLS — counts toward 3-try budget
  | { kind: 'deferred'; retryAfterMs: number }; // 429 — re-enqueue, do NOT count toward budget

// Thrown by the proxy adapter so the extractor's chain segment can branch
// on classification cleanly. Adapter errors that aren't ExtractionError
// (e.g. programmer bugs) bubble up as 'retryable' by default — see the
// chain segment below.
export class ExtractionError extends Error {
  constructor(message: string, public readonly classification: ExtractionErrorKind) {
    super(message);
    this.name = 'ExtractionError';
  }
}

export type ExtractionRunner = (ocrText: string) => Promise<ExtractionResult>;
export type GeocoderRunner = (name: string, city: string) => Promise<GeocodeResult | null>;

export type Extractor = {
  enqueueExtraction(screenshotId: string): void;
  runExtractionSweep(): Promise<void>;
  runStartupRecovery(): Promise<void>;
  /**
   * Test-only. Resolves once the in-memory queue has fully drained.
   * Production code should not need to call this.
   */
  _awaitIdle(): Promise<void>;
};

export type CreateExtractorOptions = {
  db: Database;
  extract: ExtractionRunner;
  geocode: GeocoderRunner;
  ownerId: string;
  maxRetries?: number;
  /** Deferred-retry timer. Default: globalThis.setTimeout. Tests inject. */
  setTimer?: (cb: () => void, ms: number) => unknown;
  /** UUID for new place rows. Default: crypto.randomUUID. Tests inject. */
  uuid?: () => string;
  /** Timestamp source. Default: () => new Date().toISOString(). Tests inject. */
  now?: () => string;
};

type ProcessOutcome =
  | { kind: 'done' }                             // success or permanent failure or empty-OCR
  | { kind: 'retry' }                            // append back to chain immediately
  | { kind: 'deferred'; retryAfterMs: number };  // schedule timer

export function createExtractor(opts: CreateExtractorOptions): Extractor {
  const maxRetries = opts.maxRetries ?? 3;
  const getNow = opts.now ?? (() => new Date().toISOString());
  const setTimer =
    opts.setTimer ?? ((cb: () => void, ms: number) => globalThis.setTimeout(cb, ms));
  const uuid = opts.uuid ?? defaultUuid;

  let chain: Promise<void> = Promise.resolve();
  // `inflight` engages from the moment a row enters the queue until it's
  // truly resolved (success, permanent fail, or budget exhausted). For
  // 429 deferrals we keep it engaged through the wait so a foreground
  // sweep doesn't squeeze in a duplicate timer.
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
          // Inflight stays engaged across the wait. When the timer
          // fires we re-append directly without going through enqueue
          // (which would dedup against ourselves).
          appendToChain(id);
        }, outcome.retryAfterMs);
        return;
      }
      // 'done' — release the row.
      inflight.delete(id);
      retryCount.delete(id);
    });
  }

  async function processOne(id: string): Promise<ProcessOutcome> {
    const row = await opts.db.getFirstAsync<{ ocr_text: string | null }>(
      `SELECT ocr_text FROM screenshots WHERE id = ? AND deleted_at IS NULL`,
      id,
    );
    if (!row) return { kind: 'done' };

    const ocrText = (row.ocr_text ?? '').trim();
    if (!ocrText) {
      // Empty-OCR short-circuit: classifier signal of "noise". No proxy call.
      const ts = getNow();
      await opts.db.runAsync(
        `UPDATE screenshots
            SET extraction_status = 'done', updated_at = ?
          WHERE id = ?`,
        ts,
        id,
      );
      notifyChange('screenshots');
      return { kind: 'done' };
    }

    let result: ExtractionResult;
    try {
      result = await opts.extract(ocrText);
    } catch (err) {
      const classification =
        err instanceof ExtractionError
          ? err.classification
          : ({ kind: 'retryable' } as const);
      return classifyFailure(id, classification);
    }

    // Per-call dedup: drop case-insensitive name + trimmed-city duplicates
    // before INSERT. LLMs occasionally repeat in list mode; this keeps
    // place_count honest.
    const seen = new Set<string>();
    const distinct = result.places.filter((p) => {
      const key = `${p.name.toLowerCase()}::${p.city.trim().toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Geocode sequentially. A failure / null leaves coords NULL; tap-to-Maps
    // falls back to the query-string URL.
    const geocoded = await Promise.all(
      distinct.map(async (p) => ({
        place: p,
        geo: await safeGeocode(opts.geocode, p.name, p.city),
      })),
    );

    const ts = getNow();
    try {
      await opts.db.withTransactionAsync(async () => {
        for (const { place, geo } of geocoded) {
          await opts.db.runAsync(
            `INSERT INTO extracted_places (
               id, screenshot_id, name, city, category,
               latitude, longitude, formatted_address, apple_maps_url,
               extraction_model, owner_id, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            uuid(),
            id,
            place.name,
            place.city,
            place.category,
            geo?.latitude ?? null,
            geo?.longitude ?? null,
            geo?.formattedAddress ?? null,
            geo?.appleMapsUrl ?? null,
            result.model,
            opts.ownerId,
            ts,
            ts,
          );
        }
        await opts.db.runAsync(
          `UPDATE screenshots
              SET extraction_status = 'done', updated_at = ?
            WHERE id = ?`,
          ts,
          id,
        );
      });
    } catch (err) {
      // FK constraint failure (screenshot hard-deleted between load and
      // insert) is treated as permanent. Anything else is treated as
      // retryable (transient DB lock, etc.).
      const isPermanent = String(err).includes('FOREIGN KEY');
      return classifyFailure(id, isPermanent ? { kind: 'permanent' } : { kind: 'retryable' });
    }

    notifyChange('extracted_places');
    notifyChange('screenshots');
    return { kind: 'done' };
  }

  function classifyFailure(
    id: string,
    classification: ExtractionErrorKind,
  ): ProcessOutcome {
    if (classification.kind === 'deferred') {
      return { kind: 'deferred', retryAfterMs: classification.retryAfterMs };
    }
    if (classification.kind === 'permanent') {
      void markFailed(id);
      return { kind: 'done' };
    }
    // retryable: consume budget
    const next = (retryCount.get(id) ?? 0) + 1;
    retryCount.set(id, next);
    if (next < maxRetries) return { kind: 'retry' };
    void markFailed(id);
    return { kind: 'done' };
  }

  async function markFailed(id: string): Promise<void> {
    await opts.db.runAsync(
      `UPDATE screenshots
          SET extraction_status = 'failed', updated_at = ?
        WHERE id = ?`,
      getNow(),
      id,
    );
    notifyChange('screenshots');
  }

  async function runExtractionSweep(): Promise<void> {
    // Mid-session sweeps deliberately skip 'failed' rows: a permanently
    // broken row should not burn a Gemini call on every foreground. The
    // retry-on-relaunch path is runStartupRecovery (called once per process).
    const rows = await opts.db.getAllAsync<{ id: string }>(
      `SELECT id FROM screenshots
        WHERE extraction_status = 'pending'
          AND ocr_status = 'done'
          AND deleted_at IS NULL
     ORDER BY captured_at ASC`,
    );
    for (const r of rows) enqueueExtraction(r.id);
  }

  async function runStartupRecovery(): Promise<void> {
    await opts.db.runAsync(
      `UPDATE screenshots
          SET extraction_status = 'pending', updated_at = ?
        WHERE extraction_status = 'failed' AND deleted_at IS NULL`,
      getNow(),
    );
  }

  async function _awaitIdle(): Promise<void> {
    while (true) {
      const before = chain;
      await before;
      if (chain === before) return;
    }
  }

  return { enqueueExtraction, runExtractionSweep, runStartupRecovery, _awaitIdle };
}

async function safeGeocode(
  geocode: GeocoderRunner,
  name: string,
  city: string,
): Promise<GeocodeResult | null> {
  try {
    return await geocode(name, city);
  } catch {
    return null;
  }
}

function defaultUuid(): string {
  // crypto.randomUUID exists in Node 19+, RN's Hermes, and modern web.
  // Tests inject seqUuid; production wires through expo-crypto in index.ts.
  return globalThis.crypto.randomUUID();
}
