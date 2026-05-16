import type { Database } from '@/modules/storage';
import { notifyChange } from '@/modules/storage';
import { applyUrlFetchResult, setFetchedVia } from '@/modules/storage/sources';
import { getForceStrategy } from '@/modules/extraction/config';
import { strategyForUrlAfterFetch } from '@/modules/extraction/strategies/select';
import { getExtractor } from '@/modules/extraction';
import { startStage } from '@/modules/pipeline-log';
import {
  FetchPostError,
  type FetchPostResult,
  workerErrorCodeFor,
} from '@/modules/capture/fetchPostFromProxy';
import { detectPlatformFromUrl } from '@/modules/capture/importUrl';

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
   * Clears url-fetch entitlement-paused rows and re-enqueues them. Returns the
   * number of rows unpaused so callers can decide whether to surface a
   * "Resuming…" toast.
   */
  resumeUrlFetchEntitlementPaused(): Promise<number>;
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
  /**
   * Best-effort temp-file deletion for IG carousel slides 2..N. After OCR'ing
   * a slide we don't keep the bytes locally — the WebView playback in the
   * source detail screen pulls slides from IG's CDN on demand. Defaults to
   * a no-op (the runtime wires this to expo-file-system; tests can spy on it).
   */
  disposeFile?: (path: string) => Promise<void>;
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

    const ocrStage = startStage('ocr', id);
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
      ocrStage.done({ ocrLength: ocrText.length, ocrText });
      // Chain into AI extraction. Non-blocking; the extraction queue runs
      // in its own Promise chain. No-op when no extractor is provisioned
      // (Jest, share extension, web).
      getExtractor()?.enqueueExtraction(id);
      return { retry: false };
    } catch (err) {
      const key = `ocr:${id}`;
      const next = (retryCount.get(key) ?? 0) + 1;
      retryCount.set(key, next);
      // Retries are per-attempt — emit failed for *this* attempt so the
      // diagnostics stream shows each try distinctly. See spec §Module shape.
      ocrStage.failed(err);
      if (next < maxRetries) return { retry: true };
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
      url_fetch_paused_reason: string | null;
    }>(`SELECT url, file_path, url_fetch_paused_reason FROM sources WHERE id = ?`, id);
    if (!row?.url) return { retry: false };
    if (row.file_path !== null) {
      // Worker fetch already completed for this row (e.g. retried after a
      // crash recovery). Skip straight to OCR.
      enqueueOcr(id);
      return { retry: false };
    }
    // Row paused for entitlement — do not re-attempt until resume clears it.
    if (row.url_fetch_paused_reason === 'entitlement') return { retry: false };

    const urlFetchStage = startStage('url_fetch', id);
    let result: FetchPostResult;
    try {
      result = await opts.fetchPost(row.url);
      // Spread the worker's _debug echo (route, ogOutcome, apifyOutcome,
      // cacheHit) into the firehose line so the dispatch decision is visible
      // alongside the phone-side outcome. See spec §Worker debug echo.
      urlFetchStage.done({
        imageUrlsCount: result.imageUrls.length,
        captionLength: result.caption.length,
        author: result.author,
        caption: result.caption,
        ...(result._debug ?? {}),
      });
    } catch (err) {
      const classification =
        err instanceof FetchPostError ? err.classification : { kind: 'retryable' as const };

      // Entitlement pause is expected — not an error. Settle the stage as done
      // (with a pausedReason hint) BEFORE touching the failed() path so that
      // the pipeline-log records status='done' and Sentry is never notified.
      if (classification.kind === 'entitlement-required') {
        await opts.db.runAsync(
          `UPDATE sources
              SET url_fetch_paused_reason = 'entitlement', updated_at = ?
            WHERE id = ?`,
          getNow(),
          id,
        );
        urlFetchStage.done({ pausedReason: 'entitlement' });
        notifyChange('sources');
        return { retry: false };
      }

      // Emit failed for this attempt before retry-budget logic so each try
      // shows up distinctly in the diagnostics stream (spec §Module shape).
      // Tags let Sentry filter "TikTok extraction failing" from generic
      // noise — see 2026-05-13-tiktok-slideshow-parsing-design.md §Monitoring.
      const platform = detectPlatformFromUrl(row.url);
      const tags: Record<string, string> = {
        worker_error_code: workerErrorCodeFor(err),
      };
      if (platform) tags.platform = platform;
      urlFetchStage.failed(err, { tags });
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

    // Single-image (length 0 or 1): existing flow. Download the cover (if
    // any) to a permanent path; OCR runs as a separate stage via enqueueOcr.
    //
    // Carousel (length > 1): orchestrate download + OCR + cleanup inline so
    // the slide bytes never outlive their OCR pass. Only the cover persists.
    if (result.imageUrls.length <= 1) {
      let downloadedPath: string | null = null;
      if (result.imageUrls.length === 1 && opts.downloadImage) {
        const downloadStage = startStage('image_download', id);
        try {
          downloadedPath = await opts.downloadImage(result.imageUrls[0]!);
          downloadStage.done({
            requestedCount: 1,
            downloadedCount: 1,
            coverPath: downloadedPath,
          });
        } catch (err) {
          // Don't fail the whole source on a CDN hiccup. Caption alone is
          // often enough (list-style IG posts).
          console.warn('[processor] image download failed', id, err);
          downloadStage.failed(err);
        }
      }
      const strategy = strategyForUrlAfterFetch(
        getForceStrategy(),
        downloadedPath !== null,
        result.caption.length > 0,
      );
      await applyUrlFetchResult(opts.db, id, downloadedPath, result.caption, strategy);
      // OCR runs for ocrTextLLM; vision strategies skip OCR and go straight
      // to the extractor (the row already has file_path + caption set).
      if (strategy === 'ocrTextLLM') {
        enqueueOcr(id);
      } else {
        getExtractor()?.enqueueExtraction(id);
      }
      return { retry: false };
    }

    // Carousel path. Cover (imageUrls[0]) is persisted; slides [1..N) are
    // downloaded, OCR'd, and immediately deleted. Per-slide failures (download
    // or OCR) are tolerated — we just skip that slide's contribution.
    if (!opts.downloadImage) {
      // No downloader provisioned (test posture). Treat as caption-only.
      const strategy = strategyForUrlAfterFetch(
        getForceStrategy(),
        false,
        result.caption.length > 0,
      );
      await applyUrlFetchResult(opts.db, id, null, result.caption, strategy);
      // No file means vision strategies can't run; strategy collapses to
      // ocrTextLLM and we go through the normal OCR path (caption-only).
      enqueueOcr(id);
      return { retry: false };
    }

    const downloadStage = startStage('image_download', id);
    let coverPath: string | null = null;
    try {
      coverPath = await opts.downloadImage(result.imageUrls[0]!);
    } catch (err) {
      console.warn('[processor] cover download failed', id, err);
    }

    if (!coverPath) {
      // Without a cover image, even the carousel collapses to caption-only —
      // matches the single-image-failure UX. Counts the cover request even
      // though it failed so the firehose line is legible.
      downloadStage.done({
        requestedCount: result.imageUrls.length,
        downloadedCount: 0,
        coverPath: null,
      });
      const strategy = strategyForUrlAfterFetch(
        getForceStrategy(),
        false,
        result.caption.length > 0,
      );
      await applyUrlFetchResult(opts.db, id, null, result.caption, strategy);
      enqueueOcr(id);
      return { retry: false };
    }

    const slidePaths: string[] = [];
    for (let i = 1; i < result.imageUrls.length; i++) {
      try {
        const p = await opts.downloadImage(result.imageUrls[i]!);
        slidePaths.push(p);
      } catch (err) {
        console.warn('[processor] slide download failed', id, i, err);
      }
    }

    // 1 (cover) + N successful slides. Partial slide loss is tolerated and
    // surfaces as downloadedCount < requestedCount — not a `failed` event.
    downloadStage.done({
      requestedCount: result.imageUrls.length,
      downloadedCount: 1 + slidePaths.length,
      coverPath,
    });

    // OCR cover first, then each successfully downloaded slide. Failures are
    // logged and skipped; we never let one slide's error sink the source.
    // Each image gets its own `ocr` stage row so the carousel sequence is
    // visible in the diagnostics stream (spec §Tests).
    const ocrSegments: string[] = [];
    const coverOcrStage = startStage('ocr', id);
    try {
      const coverText = await opts.ocr(coverPath);
      if (coverText.length > 0) ocrSegments.push(coverText);
      coverOcrStage.done({ ocrLength: coverText.length, ocrText: coverText, slide: 0 });
    } catch (err) {
      console.warn('[processor] cover OCR failed', id, err);
      coverOcrStage.failed(err);
    }
    for (let i = 0; i < slidePaths.length; i++) {
      const slidePath = slidePaths[i]!;
      const slideOcrStage = startStage('ocr', id);
      try {
        const t = await opts.ocr(slidePath);
        if (t.length > 0) ocrSegments.push(t);
        slideOcrStage.done({ ocrLength: t.length, ocrText: t, slide: i + 1 });
      } catch (err) {
        console.warn('[processor] slide OCR failed', id, err);
        slideOcrStage.failed(err);
      }
    }
    if (result.caption.length > 0) ocrSegments.push(result.caption);

    const finalText = ocrSegments.join(CAPTION_SEPARATOR);

    // Persist atomically: file_path → cover, caption → caption, ocr_text →
    // final concat, ocr_status → done. After this row update, a crash leaves
    // a complete source (extraction may still re-run, which is fine). The
    // strategy stamp is set BEFORE the OCR-status update so a crash mid-flight
    // still has a consistent row: file present, strategy chosen, ocr pending.
    const strategy = strategyForUrlAfterFetch(
      getForceStrategy(),
      coverPath !== null,
      result.caption.length > 0,
    );
    await applyUrlFetchResult(opts.db, id, coverPath, result.caption, strategy);
    await opts.db.runAsync(
      `UPDATE sources
          SET ocr_text = ?, ocr_status = 'done', updated_at = ?
        WHERE id = ?`,
      finalText,
      getNow(),
      id,
    );
    notifyChange('sources');

    // Drop the slide bytes. Best-effort: a failure here is a stranded temp
    // file, not a data integrity problem.
    if (opts.disposeFile) {
      for (const slidePath of slidePaths) {
        try {
          await opts.disposeFile(slidePath);
        } catch (err) {
          console.warn('[processor] slide cleanup failed', id, err);
        }
      }
    }

    getExtractor()?.enqueueExtraction(id);
    return { retry: false };
  }

  async function runOcrSweep(): Promise<void> {
    // Mid-session sweeps deliberately skip 'failed' rows: a permanently
    // broken file should not burn a Vision call on every foreground. The
    // retry-on-relaunch path is runStartupRecovery (called once per process).
    //
    // Strategy gate: only ocrTextLLM (and legacy NULL) rows need on-device
    // OCR. Vision strategies bypass OCR entirely — the extraction sweep
    // picks them up directly. This means OCR is a no-op for vision rows;
    // the on-device OCR module is preserved as a one-flag-flip rollback
    // path (spec 2026-05-16-…-design.md §Rollback).
    const rows = await opts.db.getAllAsync<{ id: string }>(
      `SELECT id FROM sources
        WHERE ocr_status = 'pending'
          AND (extraction_strategy IS NULL OR extraction_strategy = 'ocrTextLLM')
          AND (kind = 'image' OR file_path IS NOT NULL OR caption IS NOT NULL)
     ORDER BY captured_at ASC`,
    );
    for (const r of rows) enqueueOcr(r.id);
  }

  async function runUrlFetchSweep(): Promise<void> {
    if (!opts.fetchPost) return;
    // URL sources still waiting on the worker call: file_path NULL, caption
    // NULL, but the source row is in 'pending' for ocr_status. Paused rows
    // (url_fetch_paused_reason IS NOT NULL) are skipped — they re-enter via
    // resumeUrlFetchEntitlementPaused once entitlement is restored.
    const rows = await opts.db.getAllAsync<{ id: string }>(
      `SELECT id FROM sources
        WHERE kind = 'url'
          AND ocr_status = 'pending'
          AND file_path IS NULL
          AND caption IS NULL
          AND url_fetch_paused_reason IS NULL
     ORDER BY captured_at ASC`,
    );
    for (const r of rows) enqueueUrlFetch(r.id);
  }

  async function resumeUrlFetchEntitlementPaused(): Promise<number> {
    const rows = await opts.db.getAllAsync<{ id: string }>(
      `SELECT id FROM sources WHERE url_fetch_paused_reason = 'entitlement'`,
    );
    if (rows.length === 0) return 0;
    await opts.db.runAsync(
      `UPDATE sources SET url_fetch_paused_reason = NULL, updated_at = ?
       WHERE url_fetch_paused_reason = 'entitlement'`,
      getNow(),
    );
    notifyChange('sources');
    for (const r of rows) enqueueUrlFetch(r.id);
    return rows.length;
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
    resumeUrlFetchEntitlementPaused,
    _awaitIdle,
  };
}
