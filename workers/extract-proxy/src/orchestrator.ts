import * as Sentry from '@sentry/cloudflare';
import type { Env } from './index';
import type {
  OrchestratorRequest,
  OrchestratorState,
  EnrichedPlace,
  ExtractJobMessage,
} from './orchestrator-schema';
import type { WaitUntilCtx } from './video';
import type { RequestBody, ExtractedPlace } from './schema';
import { runFetchPost as defaultRunFetchPost, TransientFetchError } from './fetch-post';
import { runExtract as defaultRunExtract } from './index';
import type { FetchPostResponse } from './fetch-post';
import { dedupePlaces } from './dedupe';
import { RunExtractError } from './index';
import {
  searchAndDetailsForPlace as defaultSearchAndDetails,
  buildBulkBlurb as defaultBuildBulkBlurb,
  PlacesError,
  type PlaceDetails,
  type BlurbResult,
} from './enrich';
import { logEvent, logStageError, type ExtractMode } from './logger';

export const EXTRACT_STATE_TTL_SECONDS = 72 * 60 * 60;

/**
 * Stale-pending threshold. If a KV state is `pending` (or `partial`) with a
 * startedAt older than this, the worker that wrote it is presumed dead
 * (isolate killed mid-run, or a queue stage hit max_retries) and we
 * re-orchestrate by enqueuing a fresh fetch-post message.
 *
 * Each stage now runs in its own Worker invocation with its own 30s
 * ctx.waitUntil budget, so the practical pipeline ceiling is ~3x what it
 * was before. 90s is still well above the worst observed end-to-end. Must
 * stay in sync with the client-side mirror in lib/extract/pollExtract.ts.
 */
export const STALE_PENDING_MS = 90 * 1000;

const KV_KEY = (hash: string): string => `state:${hash}`;

export type RunFetchPostFn = (
  url: string,
  env: Env,
) => Promise<{ result: FetchPostResponse; cacheKind: 'og' | 'apify' }>;

export type RunExtractFn = (
  body: RequestBody,
  env: Env,
  ctx: WaitUntilCtx,
) => Promise<{ places: ExtractedPlace[]; model: string }>;

export type SearchAndDetailsFn = (
  req: {
    name: string;
    city: string;
    address: string;
    ocr_caption: string;
    extracted_place_id: string;
  },
  env: Env,
) => Promise<PlaceDetails | null>;

export type BuildBulkBlurbFn = (
  items: Array<{
    id: string;
    name: string;
    city: string;
    ocr_caption: string;
    details: PlaceDetails;
  }>,
  env: Env,
) => Promise<Map<string, BlurbResult>>;

export type OrchestrateDeps = {
  runFetchPost?: RunFetchPostFn;
  runExtract?: RunExtractFn;
  searchAndDetails?: SearchAndDetailsFn;
  buildBulkBlurb?: BuildBulkBlurbFn;
  /** Test seam — fetches the cover URL and returns base64 image data. */
  fetchImageBase64?: (url: string) => Promise<string>;
};

export async function readState(hash: string, env: Env): Promise<OrchestratorState | null> {
  const raw = await env.EXTRACT_STATE.get(KV_KEY(hash));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as OrchestratorState;
  } catch {
    return null;
  }
}

async function writeState(state: OrchestratorState, env: Env): Promise<void> {
  state.updatedAt = new Date().toISOString();
  await env.EXTRACT_STATE.put(KV_KEY(state.contentHash), JSON.stringify(state), {
    expirationTtl: EXTRACT_STATE_TTL_SECONDS,
  });
}

// ---------------------------------------------------------------------------
// Pipeline entry: queue producer
// ---------------------------------------------------------------------------

/**
 * Kick off the extraction pipeline for one share. Idempotent: if a usable
 * state already exists, do nothing. `done` and `error` are terminal;
 * `pending`/`partial` are honoured unless older than STALE_PENDING_MS, in
 * which case the prior invocation is presumed dead and we re-enqueue.
 *
 * The pipeline runs as three sequential queue stages — fetch-post → extract
 * → enrich — each in its own Worker invocation with its own ctx.waitUntil
 * budget. POST /extract calls this and returns 202; the rest runs async.
 */
export async function kickOffPipeline(req: OrchestratorRequest, env: Env): Promise<void> {
  const existing = await readState(req.contentHash, env);
  if (existing && (existing.status === 'done' || existing.status === 'error')) {
    logEvent({
      event: 'orchestrate_skip',
      contentHash: req.contentHash,
      status: existing.status,
    });
    return;
  }
  if (existing && (existing.status === 'pending' || existing.status === 'partial')) {
    const startedAt = existing.startedAt ? Date.parse(existing.startedAt) : 0;
    const age = Date.now() - startedAt;
    if (Number.isFinite(age) && age < STALE_PENDING_MS) {
      logEvent({
        event: 'orchestrate_skip',
        contentHash: req.contentHash,
        status: existing.status,
        duration_ms: age,
      });
      return;
    }
    logEvent({
      event: 'orchestrate_stale_pending',
      contentHash: req.contentHash,
      status: existing.status,
      duration_ms: age,
    });
  }

  const startedAt = new Date().toISOString();
  await writeState({ contentHash: req.contentHash, status: 'pending', startedAt }, env);
  await env.EXTRACT_QUEUE.send({
    stage: 'fetch-post',
    contentHash: req.contentHash,
    url: req.url,
    ...(req.suggestedTripId ? { suggestedTripId: req.suggestedTripId } : {}),
  });
}

// ---------------------------------------------------------------------------
// Queue consumer: dispatches one message to the right stage handler
// ---------------------------------------------------------------------------

/**
 * Route one queue message to its stage handler. Wraps the call in a
 * per-share Sentry isolation scope so the contentHash tag attaches to
 * every event/error this invocation emits without leaking across shares.
 *
 * Stages signal:
 *   - permanent failure → catch internally, writeState('error'), return.
 *     The message will be ack'd by the caller.
 *   - transient failure (will throw) → caller should let CF retry the
 *     message with backoff (up to max_retries; then DLQ).
 */
export async function routeStage(
  msg: ExtractJobMessage,
  env: Env,
  ctx: WaitUntilCtx,
  deps: OrchestrateDeps = {},
): Promise<void> {
  return Sentry.withIsolationScope(async () => {
    Sentry.setTag('contentHash', msg.contentHash);
    Sentry.setTag('stage', msg.stage);
    switch (msg.stage) {
      case 'fetch-post':
        return processFetchPostStage(msg, env, deps);
      case 'extract':
        return processExtractStage(msg, env, ctx, deps);
      case 'enrich':
        return processEnrichStage(msg, env, deps);
    }
  });
}

// ---------------------------------------------------------------------------
// Stage 1: fetch-post
// ---------------------------------------------------------------------------

async function processFetchPostStage(
  msg: { contentHash: string; url: string; suggestedTripId?: string },
  env: Env,
  deps: OrchestrateDeps,
): Promise<void> {
  const state = await readState(msg.contentHash, env);
  if (state && (state.status === 'done' || state.status === 'error')) {
    // A prior run already terminated. Don't redo the work.
    logEvent({
      event: 'orchestrate_skip',
      contentHash: msg.contentHash,
      status: state.status,
    });
    return;
  }
  const startedAt = state?.startedAt ?? new Date().toISOString();

  const runFetchPost = deps.runFetchPost ?? defaultRunFetchPost;

  const fetchStart = Date.now();
  logEvent({ event: 'stage_start', stage: 'fetch-post', contentHash: msg.contentHash });
  let fetched: FetchPostResponse;
  let cacheKind: 'og' | 'apify';
  try {
    const out = await runFetchPost(msg.url, env);
    fetched = out.result;
    cacheKind = out.cacheKind;
  } catch (err) {
    if (err instanceof TransientFetchError) {
      // Apify actor timeout / rate-limit / network blip. Let the queue
      // runtime retry this stage with backoff (max_retries before DLQ);
      // the KV state stays at `pending`, so the client keeps showing the
      // processing spinner instead of flipping the source to "failed".
      logEvent({
        event: 'orchestrate_fetch_transient',
        contentHash: msg.contentHash,
        duration_ms: Date.now() - fetchStart,
        detail: err.detail,
      });
      throw err;
    }
    logStageError(err, {
      stage: 'fetch-post',
      contentHash: msg.contentHash,
      duration_ms: Date.now() - fetchStart,
      error_code: 'fetch-failed',
    });
    await writeState(
      { contentHash: msg.contentHash, status: 'error', error: 'fetch-failed', startedAt },
      env,
    );
    return;
  }
  Sentry.setTag('source', fetched.platform);
  logEvent({
    event: 'stage_done',
    stage: 'fetch-post',
    contentHash: msg.contentHash,
    source: fetched.platform,
    duration_ms: Date.now() - fetchStart,
    cache_kind: cacheKind,
  });

  await writeState(
    {
      contentHash: msg.contentHash,
      status: 'partial',
      caption: fetched.caption,
      coverUrl: fetched.imageUrls[0],
      videoPresent: !!fetched.videoUrl,
      fetched,
      startedAt,
    },
    env,
  );

  await env.EXTRACT_QUEUE.send({ stage: 'extract', contentHash: msg.contentHash });
}

// ---------------------------------------------------------------------------
// Stage 2: extract (Gemini)
// ---------------------------------------------------------------------------

async function processExtractStage(
  msg: { contentHash: string },
  env: Env,
  ctx: WaitUntilCtx,
  deps: OrchestrateDeps,
): Promise<void> {
  const state = await readState(msg.contentHash, env);
  if (!state) {
    // KV TTL expired between fetch-post and extract — unusual (TTL is 72h)
    // but possible if the queue backlogged. Surface as error; the user can
    // re-share to recover.
    logStageError(new Error('state-missing'), {
      stage: 'extract',
      contentHash: msg.contentHash,
      error_code: 'state-missing',
    });
    return;
  }
  if (state.status === 'done' || state.status === 'error') {
    logEvent({
      event: 'orchestrate_skip',
      contentHash: msg.contentHash,
      status: state.status,
    });
    return;
  }
  if (!state.fetched) {
    // The fetch-post stage didn't persist the fetched payload — shouldn't
    // happen with current code, but defend against schema drift / older
    // KV rows surviving a deploy.
    logStageError(new Error('fetched-missing'), {
      stage: 'extract',
      contentHash: msg.contentHash,
      error_code: 'fetched-missing',
    });
    await writeState(
      {
        ...state,
        contentHash: msg.contentHash,
        status: 'error',
        error: 'fetched-missing',
      },
      env,
    );
    return;
  }
  const fetched = state.fetched;
  const startedAt = state.startedAt ?? new Date().toISOString();
  Sentry.setTag('source', fetched.platform);

  const runExtract = deps.runExtract ?? defaultRunExtract;
  const fetchImageBase64 = deps.fetchImageBase64 ?? defaultFetchImageBase64;

  const extractStart = Date.now();
  logEvent({
    event: 'stage_start',
    stage: 'extract',
    contentHash: msg.contentHash,
    source: fetched.platform,
  });
  let result: { places: ExtractedPlace[]; model: string };
  try {
    result = await tryExtractWithFallback(
      fetched,
      env,
      ctx,
      runExtract,
      fetchImageBase64,
      msg.contentHash,
    );
  } catch (err) {
    if (err instanceof TransientExtractError) {
      // Every fallback mode failed transient. Re-throw so the queue runtime
      // retries this stage with backoff (max_retries before DLQ). The KV
      // partial state stays put — fetched is persisted, so the retry skips
      // fetch-post entirely and goes straight to a fresh Gemini attempt.
      logEvent({
        event: 'orchestrate_extract_transient',
        contentHash: msg.contentHash,
        source: fetched.platform,
        duration_ms: Date.now() - extractStart,
        detail: err.details,
      });
      throw err;
    }
    const code = err instanceof Error ? err.message : String(err);
    const errorCode =
      code === 'no-extractable-content' ? 'no-extractable-content' : 'extract-failed';
    logStageError(err, {
      stage: 'extract',
      contentHash: msg.contentHash,
      source: fetched.platform,
      duration_ms: Date.now() - extractStart,
      error_code: errorCode,
    });
    await writeState(
      {
        contentHash: msg.contentHash,
        status: 'error',
        error: errorCode,
        caption: fetched.caption,
        coverUrl: fetched.imageUrls[0],
        videoPresent: !!fetched.videoUrl,
        fetched,
        startedAt,
      },
      env,
    );
    return;
  }
  logEvent({
    event: 'stage_done',
    stage: 'extract',
    contentHash: msg.contentHash,
    source: fetched.platform,
    duration_ms: Date.now() - extractStart,
  });

  // Write `done` with un-enriched places. The source unsticks now; the
  // enrich stage runs next in its own invocation and overwrites with
  // Google-Places-enriched data. If the enrich stage hits its own budget,
  // the un-enriched done is already in place and the client's lazy
  // enricher backfills the missing fields.
  const extractedDeduped = dedupePlaces(result.places);
  const unenrichedPlaces: EnrichedPlace[] = extractedDeduped.map((p) => ({
    ...p,
    blurb: null,
    blurb_status: 'failed' as const,
  }));
  await writeState(
    {
      contentHash: msg.contentHash,
      status: 'done',
      caption: fetched.caption,
      coverUrl: fetched.imageUrls[0],
      videoPresent: !!fetched.videoUrl,
      fetched,
      places: unenrichedPlaces,
      model: result.model,
      startedAt,
    },
    env,
  );
  logEvent({
    event: 'orchestrate_early_done',
    contentHash: msg.contentHash,
    source: fetched.platform,
    place_count: unenrichedPlaces.length,
  });

  await env.EXTRACT_QUEUE.send({ stage: 'enrich', contentHash: msg.contentHash });
}

// ---------------------------------------------------------------------------
// Stage 3: enrich (Google Places upgrade)
// ---------------------------------------------------------------------------

async function processEnrichStage(
  msg: { contentHash: string },
  env: Env,
  deps: OrchestrateDeps,
): Promise<void> {
  const state = await readState(msg.contentHash, env);
  if (!state) {
    logStageError(new Error('state-missing'), {
      stage: 'enrich',
      contentHash: msg.contentHash,
      error_code: 'state-missing',
    });
    return;
  }
  if (state.status === 'error') {
    logEvent({
      event: 'orchestrate_skip',
      contentHash: msg.contentHash,
      status: state.status,
    });
    return;
  }
  if (state.status !== 'done' || !state.places || state.places.length === 0) {
    // The extract stage should have left a `done` with places. If we're
    // here without that, the prior stage must have failed; log + return.
    logStageError(new Error('enrich-precondition'), {
      stage: 'enrich',
      contentHash: msg.contentHash,
      error_code: 'enrich-precondition',
    });
    return;
  }
  // Skip if already enriched (idempotency for queue redelivery): at least
  // one place has an external_place_id.
  const alreadyEnriched = state.places.some((p) => p.external_place_id);
  if (alreadyEnriched) {
    logEvent({
      event: 'orchestrate_skip',
      contentHash: msg.contentHash,
      status: 'done',
    });
    return;
  }

  const fetched = state.fetched;
  const source = fetched?.platform;
  if (source) Sentry.setTag('source', source);

  const searchAndDetails = deps.searchAndDetails ?? defaultSearchAndDetails;
  const buildBulkBlurb = deps.buildBulkBlurb ?? defaultBuildBulkBlurb;

  const enrichStart = Date.now();
  logEvent({
    event: 'stage_start',
    stage: 'enrich',
    contentHash: msg.contentHash,
    source,
    place_count: state.places.length,
  });

  try {
    const enrichedPlaces = await runEnrichment(
      state.places,
      fetched?.caption ?? state.caption ?? '',
      env,
      searchAndDetails,
      buildBulkBlurb,
      msg.contentHash,
      source,
    );
    logEvent({
      event: 'stage_done',
      stage: 'enrich',
      contentHash: msg.contentHash,
      source,
      duration_ms: Date.now() - enrichStart,
      place_count: enrichedPlaces.length,
    });

    await writeState(
      {
        ...state,
        contentHash: msg.contentHash,
        status: 'done',
        places: enrichedPlaces,
      },
      env,
    );
  } catch (err) {
    // Don't downgrade to error — the early-done state from the extract
    // stage is still in KV and the client's lazy enricher will pick up
    // the missing fields. Log for triage and let the message ack.
    logStageError(err, {
      stage: 'enrich',
      contentHash: msg.contentHash,
      source,
      duration_ms: Date.now() - enrichStart,
      error_code: 'enrich-upgrade-failed',
    });
  }
}

// ---------------------------------------------------------------------------
// Test helper: synchronously run the full pipeline in-process
// ---------------------------------------------------------------------------

/**
 * Run the complete fetch-post → extract → enrich pipeline synchronously in
 * the current isolate. Wraps EXTRACT_QUEUE in a stub that dispatches each
 * `send()` to the corresponding stage handler immediately, so the test sees
 * the same KV state transitions a real queue would produce — just without
 * the asynchronous handoff.
 *
 * Production code MUST NOT call this. POST /extract should call
 * `kickOffPipeline` and let the queue handler run the stages on their own
 * invocations (each with its own 30s ctx.waitUntil budget).
 */
export async function orchestrate(
  req: OrchestratorRequest,
  env: Env,
  ctx: WaitUntilCtx,
  deps: OrchestrateDeps = {},
): Promise<void> {
  return Sentry.withIsolationScope(async () => {
    Sentry.setTag('contentHash', req.contentHash);
    const stubQueue = createSyncStubQueue(env, ctx, deps);
    const envWithStub: Env = { ...env, EXTRACT_QUEUE: stubQueue };
    await kickOffPipeline(req, envWithStub);
  });
}

/**
 * In-process queue stub for tests / synchronous orchestrate(). `send()`
 * routes the message back through `routeStage` immediately, so a test
 * call to orchestrate() runs all three stages end-to-end.
 *
 * Throws from `routeStage` are intentionally swallowed: in production a
 * thrown stage handler signals "retry me", and the queue runtime
 * eventually drops the message into the DLQ. For test purposes the
 * after-state in KV is what matters (transient throws leave `partial`,
 * permanent failures wrote `error` before throwing); orchestrate()
 * always returns cleanly so existing test patterns stay readable.
 */
function createSyncStubQueue(
  env: Env,
  ctx: WaitUntilCtx,
  deps: OrchestrateDeps,
): Env['EXTRACT_QUEUE'] {
  let envWithStub: Env;
  const stub: Env['EXTRACT_QUEUE'] = {
    async send(body: ExtractJobMessage): Promise<QueueSendResponse> {
      try {
        await routeStage(body, envWithStub, ctx, deps);
      } catch (err) {
        if (err instanceof TransientExtractError) {
          // Mimic queue auto-retry → max_retries → DLQ. In tests we just
          // stop; the existing `partial` state in KV reflects the failure.
          return makeStubSendResponse();
        }
        throw err;
      }
      return makeStubSendResponse();
    },
    async sendBatch(messages): Promise<QueueSendBatchResponse> {
      for (const m of messages) {
        try {
          await routeStage(m.body as ExtractJobMessage, envWithStub, ctx, deps);
        } catch (err) {
          if (!(err instanceof TransientExtractError)) throw err;
        }
      }
      return makeStubSendBatchResponse();
    },
    async metrics(): Promise<QueueMetrics> {
      return { backlogCount: 0, backlogBytes: 0 };
    },
  };
  envWithStub = { ...env, EXTRACT_QUEUE: stub };
  return stub;
}

function makeStubSendResponse(): QueueSendResponse {
  return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
}

function makeStubSendBatchResponse(): QueueSendBatchResponse {
  return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
}

// ---------------------------------------------------------------------------
// Extraction & enrichment helpers (unchanged logic, refactored into shared
// helpers callable from the extract and enrich stages above).
// ---------------------------------------------------------------------------

/**
 * Extraction with graceful fallback across modes. Workers' egress IPs are
 * frequently blocked by TikTok's CDN even with browser-shaped headers,
 * leaving us with video-fetch-4xx. The fetch-post step already returns
 * the cover image + caption, so falling back to vision (then text) keeps
 * the place-extraction signal flowing even when video bytes are denied.
 *
 *   1. video        — most informative, requires CDN access
 *   2. vision       — cover image + caption
 *   3. text         — caption only
 *
 * The function returns the first mode that yields a Gemini response.
 * Throws when no mode is available (the post had no video, no cover,
 * and no caption — vanishingly rare) or every available mode failed
 * upstream.
 */
/**
 * Thrown by tryExtractWithFallback when every fallback mode failed with a
 * transient upstream code (Gemini 5xx, 429, network blip). Distinct from a
 * generic Error so the extract stage can let the queue runtime retry the
 * message rather than write a terminal `error` row.
 */
export class TransientExtractError extends Error {
  constructor(public readonly details: string) {
    super('extract-transient: ' + details);
    this.name = 'TransientExtractError';
  }
}

async function tryExtractWithFallback(
  fetched: FetchPostResponse,
  env: Env,
  ctx: WaitUntilCtx,
  runExtract: RunExtractFn,
  fetchImageBase64: (url: string) => Promise<string>,
  contentHash: string,
): Promise<{ places: ExtractedPlace[]; model: string }> {
  const errors: string[] = [];
  // Tracks whether every Gemini call that actually ran failed with a
  // transient code. A single permanent failure (4xx auth/bad-request,
  // malformed response) flips this off — we want the user to see those
  // as terminal rather than spinning forever.
  let attemptedCalls = 0;
  let allTransient = true;

  const tryMode = async (
    mode: ExtractMode,
    body: RequestBody,
  ): Promise<{ places: ExtractedPlace[]; model: string } | null> => {
    const start = Date.now();
    attemptedCalls++;
    try {
      const out = await runExtract(body, env, ctx);
      logEvent({
        event: 'stage_done',
        stage: 'extract',
        mode,
        contentHash,
        source: fetched.platform,
        duration_ms: Date.now() - start,
      });
      return out;
    } catch (err) {
      const code = err instanceof RunExtractError ? err.code : String(err);
      // Codes representing a retryable upstream condition. Anything else
      // — non-RunExtractError throws, schema/parse violations from
      // Gemini's response (deterministic — retrying the same input gives
      // the same bad output), misconfig — counts as permanent.
      const transient =
        code === 'upstream-error' ||
        code === 'upstream-network-error' ||
        code === 'upstream-rate-limited';
      if (!transient) allTransient = false;
      logEvent({
        event: 'stage_warn',
        stage: 'extract',
        mode,
        contentHash,
        source: fetched.platform,
        duration_ms: Date.now() - start,
        error_code: code,
      });
      errors.push(`${mode}:${code}`);
      return null;
    }
  };

  // Skip video mode for TikTok: their CDN blocks Cloudflare Workers' egress
  // IPs (residential-IP enforcement), so every video-bytes fetch 403s. We
  // still get the caption + cover via rehydration parsing on the page HTML
  // (which IS reachable), and vision mode extracts places from those just
  // fine. Skipping saves ~500ms–1s of guaranteed-fail HTTP roundtrip per
  // TikTok share. Revert this guard if TikTok ever relaxes their CDN
  // policy (re-shares will start succeeding via the next-best path
  // regardless, so this isn't urgent to discover).
  if (fetched.videoUrl && fetched.platform !== 'tiktok') {
    const out = await tryMode('video', {
      mode: 'video',
      video: {
        url: fetched.videoUrl,
        durationSec: fetched.videoDuration ?? undefined,
        refererUrl: fetched.permalink,
      },
      caption: fetched.caption,
    });
    if (out) return out;
  }

  if (fetched.imageUrls.length > 0) {
    // Carousel posts surface every slide via Apify. Fetch them in parallel
    // and forward every slide that came back so the LLM can read place
    // names that appear on slides 2+ (very common for "10 spots in X"
    // listicles where slide 1 is just a hero image). Slide-level fetch
    // failures are tolerated — a 403 on slide 7 shouldn't sink the post —
    // but if every fetch fails we fall through to text mode.
    const settled = await Promise.allSettled(fetched.imageUrls.map((u) => fetchImageBase64(u)));
    const imageBase64: string[] = [];
    for (let i = 0; i < settled.length; i++) {
      const r = settled[i]!;
      if (r.status === 'fulfilled') {
        imageBase64.push(r.value);
      } else {
        const code = r.reason instanceof Error ? r.reason.message : String(r.reason);
        logEvent({
          event: 'stage_warn',
          stage: 'extract',
          mode: 'vision',
          contentHash,
          source: fetched.platform,
          error_code: 'carousel-slide-fetch-failed',
          slide_idx: i,
          slide_count: fetched.imageUrls.length,
          slide_error: code,
        });
      }
    }
    if (imageBase64.length > 0) {
      const out = await tryMode('vision', {
        mode: 'vision',
        imageBase64,
        caption: fetched.caption,
      });
      if (out) return out;
    } else {
      errors.push('vision:image-fetch-all-failed');
    }
  }

  if (fetched.caption.trim().length > 0) {
    const out = await tryMode('text', { mode: 'text', text: fetched.caption });
    if (out) return out;
  }

  if (errors.length === 0) throw new Error('no-extractable-content');
  if (attemptedCalls > 0 && allTransient) {
    throw new TransientExtractError(errors.join(', '));
  }
  throw new Error(errors.join(', '));
}

/**
 * Resolve each extracted place against Google Places (searchText +
 * placeDetails), dedupe by place_id, and return the upgraded
 * EnrichedPlace[]. Thrown PlacesError per place becomes `not-found` —
 * those places ship without the enrichment fields but the source still
 * succeeds; the client's lazy enricher can retry them later.
 *
 * Non-PlacesError throws (e.g. Workers' "Too many subrequests") bubble
 * up so the caller can decide whether to retry the message or just log
 * and let the un-enriched done stand.
 */
async function runEnrichment(
  inputPlaces: EnrichedPlace[],
  caption: string,
  env: Env,
  searchAndDetails: SearchAndDetailsFn,
  buildBulkBlurb: BuildBulkBlurbFn,
  contentHash: string,
  source: string | undefined,
): Promise<EnrichedPlace[]> {
  const enrichmentInput = inputPlaces.map((p, i) => ({
    place: p,
    enrichKey: `${i}`,
  }));

  const detailsResults = await Promise.all(
    enrichmentInput.map(async (item) => {
      try {
        const details = await searchAndDetails(
          {
            name: item.place.name,
            city: item.place.city,
            address: item.place.address,
            ocr_caption: caption,
            extracted_place_id: item.enrichKey,
          },
          env,
        );
        return { ...item, details };
      } catch (err) {
        if (err instanceof PlacesError) {
          logEvent({
            event: 'stage_warn',
            stage: 'enrich',
            contentHash,
            source,
            error_code: `places-${err.status}`,
            place_name: item.place.name,
          });
          return { ...item, details: null };
        }
        throw err;
      }
    }),
  );

  // Dedup by place_id. Two LLM-emitted names ("Tartine" + "Tartine Bakery SF")
  // resolving to the same Google place_id collapse into one survivor — the
  // first occurrence wins. Places that came back null (not-found) survive
  // each on their own row keyed by their extraction index since we have no
  // canonical id for them.
  const survivors: typeof detailsResults = [];
  const seenPlaceIds = new Set<string>();
  for (const item of detailsResults) {
    if (item.details === null) {
      survivors.push(item);
      continue;
    }
    if (seenPlaceIds.has(item.details.id)) continue;
    seenPlaceIds.add(item.details.id);
    survivors.push(item);
  }

  // Defer bulk-blurb to client-driven per-place retries. The enrich queue
  // stage already runs in its own 30s budget, but the bulk-blurb call adds
  // 3-10s on top of the Google Places fan-out — when carousels push 15+
  // places it's safer to ship Google Places data now and let the client
  // hit /enrich for blurbs.
  const blurbInputs = survivors
    .filter((s): s is typeof s & { details: PlaceDetails } => s.details !== null)
    .map((s) => ({
      id: s.details.id,
      name: s.place.name,
      city: s.place.city,
      ocr_caption: caption,
      details: s.details,
    }));
  logEvent({
    event: 'blurb_deferred',
    contentHash,
    source,
    place_count: blurbInputs.length,
  });
  // Keep `buildBulkBlurb` in the dep map for signature stability and as a
  // re-enable seam if we ever move to a cheaper bulk model.
  void buildBulkBlurb;
  const blurbsByPlaceId: Map<string, BlurbResult> = new Map();

  return survivors.map((s) => {
    if (s.details === null) {
      return {
        ...s.place,
        blurb: null,
        blurb_status: 'not-found',
      };
    }
    const blurbResult = blurbsByPlaceId.get(s.details.id);
    return {
      ...s.place,
      external_place_id: s.details.id,
      formatted_address: s.details.formattedAddress,
      photo_name: s.details.photoName,
      display_name: s.details.displayName,
      latitude: s.details.latitude,
      longitude: s.details.longitude,
      rating: s.details.rating,
      price_level: s.details.priceLevel,
      external_url: s.details.googleMapsUri,
      editorial_summary: s.details.editorialSummary,
      blurb: blurbResult?.text ?? null,
      blurb_status: blurbResult ? blurbResult.outcome : 'failed',
    };
  });
}

async function defaultFetchImageBase64(url: string): Promise<string> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`image-fetch-${resp.status}`);
  const buf = new Uint8Array(await resp.arrayBuffer());
  // Chunked base64 to avoid stack overflow on large images.
  const CHUNK = 0x8000;
  let bin = '';
  for (let i = 0; i < buf.length; i += CHUNK) {
    bin += String.fromCharCode(...buf.subarray(i, Math.min(i + CHUNK, buf.length)));
  }
  return btoa(bin);
}
