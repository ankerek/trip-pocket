import type { Database } from '@/modules/storage';
import { notifyChange } from '@/modules/storage';
import { applyUrlFetchResult } from '@/modules/storage/sources';
import { getExtractor } from '@/modules/extraction';
import { pipelineStep, pipelineError } from '@/lib/observability';
import {
  FetchPostError,
  type FetchPostResult,
} from '@/modules/capture/fetchPostFromProxy';

export type OcrRunner = (imagePath: string) => Promise<string>;

/**
 * Downloads the cover image at `imageUrl` to a permanent local file and
 * returns the final URI. Implementations are provided by the runtime
 * (expo-file-system based) and the tests (in-memory fake). Returning a
 * URI here decouples the processor from filesystem internals.
 */
export type ImageDownloader = (imageUrl: string) => Promise<string>;

export type UrlFetcher = (postUrl: string) => Promise<FetchPostResult>;

export type Processor = {
  enqueueOcr(sourceId: string): void;
  enqueueUrlFetch(sourceId: string): void;
  runOcrSweep(): Promise<void>;
  runUrlFetchSweep(): Promise<void>;
  runStartupRecovery(): Promise<void>;
  /**
   * Test-only. Resolves once the in-memory queue has fully drained.
   * Production code should not need to call this — work happens in the
   * background and the live-query layer surfaces results.
   */
  _awaitIdle(): Promise<void>;
};

export type CreateProcessorOptions = {
  db: Database;
  ocr: OcrRunner;
  /**
   * URL-source fetcher + image downloader. Optional: when omitted, kind='url'
   * sources are skipped (useful for tests that only exercise OCR).
   */
  fetchPost?: UrlFetcher;
  downloadImage?: ImageDownloader;
  maxRetries?: number;
  now?: () => string;
};

const CAPTION_SEPARATOR = '\n---\n';

export function createProcessor(opts: CreateProcessorOptions): Processor {
  const maxRetries = opts.maxRetries ?? 3;
  const getNow = opts.now ?? (() => new Date().toISOString());

  let chain: Promise<void> = Promise.resolve();
  const inflight = new Set<string>();
  const retryCount = new Map<string, number>();

  function enqueueOcr(id: string): void {
    const key = `ocr:${id}`;
    if (inflight.has(key)) return;
    inflight.add(key);
    chain = chain.then(async () => {
      try {
        // Loop here (rather than re-enqueuing) so all retries for one id
        // happen contiguously inside this chain segment. That keeps the
        // queue strictly serial across ids and avoids the dedup juggling
        // that re-enqueue mid-chain would require.
        while (true) {
          const result = await processOne(id);
          if (!result.retry) break;
        }
      } finally {
        inflight.delete(key);
        retryCount.delete(key);
      }
    });
  }

  function enqueueUrlFetch(id: string): void {
    if (!opts.fetchPost) return; // No fetcher provisioned: skip silently.
    const key = `urlfetch:${id}`;
    if (inflight.has(key)) return;
    inflight.add(key);
    chain = chain.then(async () => {
      try {
        while (true) {
          const result = await processUrlFetch(id);
          if (!result.retry) break;
        }
      } finally {
        inflight.delete(key);
        retryCount.delete(key);
      }
    });
  }

  async function processOne(id: string): Promise<{ retry: boolean }> {
    const row = await opts.db.getFirstAsync<{
      kind: string;
      file_path: string | null;
      caption: string | null;
    }>(`SELECT kind, file_path, caption FROM sources WHERE id = ?`, id);
    if (!row) return { retry: false };

    // Caption-only path: URL source whose image download failed (or was
    // empty). Skip OCR and use the caption verbatim. Still chains into
    // extraction since the caption may contain a list of place names.
    if (row.kind === 'url' && !row.file_path) {
      const finalText = row.caption ?? '';
      await opts.db.runAsync(
        `UPDATE sources
            SET ocr_text = ?, ocr_status = 'done', updated_at = ?
          WHERE id = ?`,
        finalText,
        getNow(),
        id,
      );
      notifyChange('sources');
      getExtractor()?.enqueueExtraction(id);
      return { retry: false };
    }

    if (!row.file_path) {
      // kind='image' with no file_path is a malformed row — shouldn't happen
      // since importImage moves the file before insert. Bail.
      return { retry: false };
    }

    pipelineStep('ocr');
    try {
      const ocrText = await opts.ocr(row.file_path);
      const finalText =
        row.kind === 'url' && row.caption && row.caption.length > 0
          ? `${ocrText}${CAPTION_SEPARATOR}${row.caption}`
          : ocrText;
      await opts.db.runAsync(
        `UPDATE sources
            SET ocr_text = ?, ocr_status = 'done', updated_at = ?
          WHERE id = ?`,
        finalText,
        getNow(),
        id,
      );
      notifyChange('sources');
      // Chain into AI extraction. Non-blocking; the extraction queue runs
      // in its own Promise chain. No-op when no extractor is provisioned
      // (Jest, share extension, web).
      getExtractor()?.enqueueExtraction(id);
      return { retry: false };
    } catch (err) {
      const key = `ocr:${id}`;
      const next = (retryCount.get(key) ?? 0) + 1;
      retryCount.set(key, next);
      if (next < maxRetries) return { retry: true };
      pipelineError('ocr', err);
      await opts.db.runAsync(
        `UPDATE sources
            SET ocr_status = 'failed', updated_at = ?
          WHERE id = ?`,
        getNow(),
        id,
      );
      notifyChange('sources');
      return { retry: false };
    }
  }

  async function processUrlFetch(id: string): Promise<{ retry: boolean }> {
    if (!opts.fetchPost) return { retry: false };
    const row = await opts.db.getFirstAsync<{
      url: string | null;
      file_path: string | null;
    }>(`SELECT url, file_path FROM sources WHERE id = ?`, id);
    if (!row?.url) return { retry: false };
    if (row.file_path !== null) {
      // Worker fetch already completed for this row (e.g. retried after a
      // crash recovery). Skip straight to OCR.
      enqueueOcr(id);
      return { retry: false };
    }

    pipelineStep('url_fetch');
    let result: FetchPostResult;
    try {
      result = await opts.fetchPost(row.url);
    } catch (err) {
      const classification =
        err instanceof FetchPostError ? err.classification : { kind: 'retryable' as const };
      if (classification.kind === 'retryable') {
        const key = `urlfetch:${id}`;
        const next = (retryCount.get(key) ?? 0) + 1;
        retryCount.set(key, next);
        if (next < maxRetries) return { retry: true };
      }
      // Permanent vs retryable-exhausted: both end the in-session retry loop,
      // but only permanent failures (private/not-found/unsupported-url) earn
      // extraction_status='failed' — the marker runStartupRecovery uses to
      // skip the row on the next cold launch. Retryable-exhausted rows keep
      // extraction_status='pending' so the next cold launch promotes them
      // back to pending and tries one more 3-retry budget.
      pipelineError('url_fetch', err);
      const isPermanent = classification.kind === 'permanent';
      await opts.db.runAsync(
        isPermanent
          ? `UPDATE sources
                SET ocr_status = 'failed',
                    extraction_status = 'failed',
                    updated_at = ?
              WHERE id = ?`
          : `UPDATE sources
                SET ocr_status = 'failed',
                    updated_at = ?
              WHERE id = ?`,
        getNow(),
        id,
      );
      notifyChange('sources');
      return { retry: false };
    }

    // Image download is best-effort. Failures here downgrade to caption-only.
    let downloadedPath: string | null = null;
    if (result.imageUrls.length > 0 && opts.downloadImage) {
      try {
        downloadedPath = await opts.downloadImage(result.imageUrls[0]!);
      } catch (err) {
        // Don't fail the whole source on a CDN hiccup. Caption alone is
        // often enough (list-style IG posts).
        console.warn('[processor] image download failed', id, err);
      }
    }

    await applyUrlFetchResult(opts.db, id, downloadedPath, result.caption);
    // Whether or not we downloaded an image, OCR is the next stage.
    enqueueOcr(id);
    return { retry: false };
  }

  async function runOcrSweep(): Promise<void> {
    // Mid-session sweeps deliberately skip 'failed' rows: a permanently
    // broken file should not burn a Vision call on every foreground. The
    // retry-on-relaunch path is runStartupRecovery (called once per process).
    const rows = await opts.db.getAllAsync<{ id: string }>(
      `SELECT id FROM sources
        WHERE ocr_status = 'pending'
          AND (kind = 'image' OR file_path IS NOT NULL OR caption IS NOT NULL)
     ORDER BY captured_at ASC`,
    );
    for (const r of rows) enqueueOcr(r.id);
  }

  async function runUrlFetchSweep(): Promise<void> {
    if (!opts.fetchPost) return;
    // URL sources still waiting on the worker call: file_path NULL, caption
    // NULL, but the source row is in 'pending' for ocr_status.
    const rows = await opts.db.getAllAsync<{ id: string }>(
      `SELECT id FROM sources
        WHERE kind = 'url'
          AND ocr_status = 'pending'
          AND file_path IS NULL
          AND caption IS NULL
     ORDER BY captured_at ASC`,
    );
    for (const r of rows) enqueueUrlFetch(r.id);
  }

  async function runStartupRecovery(): Promise<void> {
    // Promote ocr_status='failed' rows back to 'pending' for one more 3-try
    // budget this session — EXCEPT rows where extraction_status='failed' too.
    // That combination is the permanent-failure marker (set by processUrlFetch
    // on private/not-found/unsupported-url) and means re-trying is wasted
    // work that hits the worker on every cold launch for no possible
    // outcome change.
    await opts.db.runAsync(
      `UPDATE sources
          SET ocr_status = 'pending', updated_at = ?
        WHERE ocr_status = 'failed'
          AND extraction_status != 'failed'`,
      getNow(),
    );
  }

  async function _awaitIdle(): Promise<void> {
    // The chain reference grows each enqueue. Awaiting any one chain reference
    // resolves only at that segment, so loop until no new work has been added
    // during the wait.
    while (true) {
      const before = chain;
      await before;
      if (chain === before) return;
    }
  }

  return {
    enqueueOcr,
    enqueueUrlFetch,
    runOcrSweep,
    runUrlFetchSweep,
    runStartupRecovery,
    _awaitIdle,
  };
}
