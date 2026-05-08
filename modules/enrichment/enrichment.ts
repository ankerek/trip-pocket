import type { Database } from '@/modules/storage';
import { notifyChange } from '@/modules/storage';

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
  extracted_place_id: string;
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
  enqueueEnrichment(extractedPlaceId: string): void;
  /** Test-only. Resolves once all in-flight work has settled. */
  _awaitIdle(): Promise<void>;
};

export type CreateEnricherOptions = {
  db: Database;
  enrich: EnrichmentRunner;
  /** Timestamp source. Default: () => new Date().toISOString(). Tests inject. */
  now?: () => string;
};

type RowSnapshot = {
  id: string;
  name: string;
  city: string;
  address: string | null;
  enrichment_status: 'pending' | 'enriched' | 'not-found' | 'failed';
  ocr_text: string;
};

export function createEnricher(opts: CreateEnricherOptions): Enricher {
  const getNow = opts.now ?? (() => new Date().toISOString());

  // Per-extracted_place_id dedup. Cleared once a row settles.
  const inflightById = new Set<string>();
  // OCR-key dedup. Two siblings (or two taps on the same row) share one
  // /enrich call; the second arrival awaits the first's promise. Key is
  // the joined OCR-key string ("<name>|<city>|<address>") because Map
  // uses reference equality on object keys — recomputed objects would
  // never collide.
  const inflightByKey = new Map<string, Promise<EnrichOutcome | EnrichmentError>>();

  // Tracks every async operation we've kicked off; _awaitIdle() drains it.
  const pending = new Set<Promise<unknown>>();

  function track<T>(p: Promise<T>): Promise<T> {
    pending.add(p);
    p.finally(() => pending.delete(p));
    return p;
  }

  // Serialize DB writes. SQLite is single-writer, and our applyOutcome
  // wraps INSERT + UPDATE + sibling-propagation in a transaction. Two
  // concurrent applyOutcomes (e.g. when two siblings both await the same
  // /enrich result) would issue overlapping BEGINs and crash. The chain
  // forces them to run sequentially.
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
    const row = await loadRow(id);
    if (!row) return;
    if (row.enrichment_status === 'enriched' || row.enrichment_status === 'not-found') {
      return;
    }
    if (!row.ocr_text || row.ocr_text.trim().length === 0) {
      // Without an OCR caption the worker can't run the blurb step. Mark
      // 'not-found' rather than 'failed' so it doesn't retry on every open.
      await enqueueWrite(() => markNotFound(id));
      return;
    }

    const ocrKey = computeOcrKey(row);
    const keyStr = `${ocrKey.name}|${ocrKey.city}|${ocrKey.address}`;

    // Pre-flight venue check: another row already resolved this venue?
    const resolved = await findResolvedSibling(ocrKey, id);
    if (resolved) {
      await enqueueWrite(() => applyEnrichedBySibling(id, resolved));
      notifyChange('extracted_places');
      return;
    }

    // OCR-key dedup. The synchronous get+set keeps siblings tied to the
    // same in-flight promise.
    let entry = inflightByKey.get(keyStr);
    if (!entry) {
      entry = runRequest(row).finally(() => {
        if (inflightByKey.get(keyStr) === entry) {
          inflightByKey.delete(keyStr);
        }
      });
      inflightByKey.set(keyStr, entry);
    }

    const settled = await entry;
    if (settled instanceof EnrichmentError) {
      await enqueueWrite(() => applyError(id, settled.classification));
      notifyChange('extracted_places');
      return;
    }

    // After the originator has run applyOutcome (with sibling propagation),
    // a re-read may show this row already 'enriched'. The applyOutcome below
    // is then idempotent — the UPDATE matches its own row, INSERT OR IGNORE
    // skips the existing place_enrichments row.
    await enqueueWrite(() => applyOutcome(id, ocrKey, settled));
    notifyChange('extracted_places');
  }

  async function runRequest(
    row: RowSnapshot,
  ): Promise<EnrichOutcome | EnrichmentError> {
    try {
      const out = await opts.enrich({
        extracted_place_id: row.id,
        name: row.name,
        city: row.city,
        address: row.address,
        ocr_caption: row.ocr_text,
      });
      return out;
    } catch (err) {
      if (err instanceof EnrichmentError) return err;
      return new EnrichmentError(String(err), 'retryable');
    }
  }

  async function loadRow(id: string): Promise<RowSnapshot | null> {
    const row = await opts.db.getFirstAsync<{
      id: string;
      name: string;
      city: string;
      address: string | null;
      enrichment_status: RowSnapshot['enrichment_status'];
      ocr_text: string | null;
    }>(
      `SELECT ep.id, ep.name, ep.city, ep.address, ep.enrichment_status,
              s.ocr_text
         FROM extracted_places ep
         JOIN screenshots s ON s.id = ep.screenshot_id
        WHERE ep.id = ? AND ep.deleted_at IS NULL AND s.deleted_at IS NULL`,
      id,
    );
    if (!row) return null;
    return { ...row, ocr_text: row.ocr_text ?? '' };
  }

  async function findResolvedSibling(
    ocrKey: OcrKey,
    excludeId: string,
  ): Promise<string | null> {
    const row = await opts.db.getFirstAsync<{ external_place_id: string }>(
      `SELECT external_place_id
         FROM extracted_places
        WHERE deleted_at IS NULL
          AND id != ?
          AND external_place_id IS NOT NULL
          AND LOWER(name) = ?
          AND LOWER(TRIM(city)) = ?
          AND LOWER(TRIM(COALESCE(address, ''))) = ?
        LIMIT 1`,
      excludeId,
      ocrKey.name,
      ocrKey.city,
      ocrKey.address,
    );
    return row?.external_place_id ?? null;
  }

  async function applyEnrichedBySibling(
    id: string,
    externalPlaceId: string,
  ): Promise<void> {
    const ts = getNow();
    await opts.db.runAsync(
      `UPDATE extracted_places
          SET external_place_id = ?,
              enrichment_status = 'enriched',
              enriched_at = ?,
              updated_at = ?
        WHERE id = ?`,
      externalPlaceId,
      ts,
      ts,
      id,
    );
  }

  async function applyOutcome(
    id: string,
    ocrKey: OcrKey,
    outcome: EnrichOutcome,
  ): Promise<void> {
    if (outcome.kind === 'not-found') {
      await markNotFound(id);
      return;
    }

    const ts = getNow();
    await opts.db.withTransactionAsync(async () => {
      await opts.db.runAsync(
        `INSERT OR IGNORE INTO place_enrichments (
           external_place_id, photo_name, description, rating, price_level,
           external_url, latitude, longitude, formatted_address,
           fetched_at, model
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      );
      await opts.db.runAsync(
        `UPDATE extracted_places
            SET external_place_id = ?,
                enrichment_status = 'enriched',
                enriched_at = ?,
                updated_at = ?
          WHERE id = ?`,
        outcome.external_place_id,
        ts,
        ts,
        id,
      );
      // Sibling propagation: any other unresolved row with the same
      // OCR-key collapses onto this venue. Keeps later opens cost-free.
      await opts.db.runAsync(
        `UPDATE extracted_places
            SET external_place_id = ?,
                enrichment_status = 'enriched',
                enriched_at = ?,
                updated_at = ?
          WHERE deleted_at IS NULL
            AND id != ?
            AND external_place_id IS NULL
            AND enrichment_status IN ('pending', 'failed')
            AND LOWER(name) = ?
            AND LOWER(TRIM(city)) = ?
            AND LOWER(TRIM(COALESCE(address, ''))) = ?`,
        outcome.external_place_id,
        ts,
        ts,
        id,
        ocrKey.name,
        ocrKey.city,
        ocrKey.address,
      );
    });
  }

  async function markNotFound(id: string): Promise<void> {
    const ts = getNow();
    await opts.db.runAsync(
      `UPDATE extracted_places
          SET enrichment_status = 'not-found',
              updated_at = ?
        WHERE id = ?`,
      ts,
      id,
    );
  }

  async function applyError(id: string, kind: EnrichErrorKind): Promise<void> {
    // Rate-limited and permanent both write 'failed'. The user re-opening
    // the card is the explicit retry signal — no automatic retry budget.
    // (Retryable transient errors fall through to 'failed' too; the next
    // open will retry. The worker's per-IP rate limit caps abuse.)
    const ts = getNow();
    await opts.db.runAsync(
      `UPDATE extracted_places
          SET enrichment_status = 'failed',
              updated_at = ?
        WHERE id = ?`,
      ts,
      id,
    );
    void kind;
  }

  async function _awaitIdle(): Promise<void> {
    while (pending.size > 0) {
      await Promise.allSettled(Array.from(pending));
    }
  }

  return { enqueueEnrichment, _awaitIdle };
}

type OcrKey = { name: string; city: string; address: string };

function computeOcrKey(row: RowSnapshot): OcrKey {
  return {
    name: row.name.toLowerCase(),
    city: row.city.trim().toLowerCase(),
    address: (row.address ?? '').trim().toLowerCase(),
  };
}
