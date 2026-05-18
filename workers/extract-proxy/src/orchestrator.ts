import * as Sentry from '@sentry/cloudflare';
import type { Env } from './index';
import type { OrchestratorRequest, OrchestratorState, EnrichedPlace } from './orchestrator-schema';
import type { WaitUntilCtx } from './video';
import type { RequestBody, ExtractedPlace } from './schema';
import { runFetchPost as defaultRunFetchPost } from './fetch-post';
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
 * (isolate killed mid-run) and we re-orchestrate. Set generously above the
 * 95th-percentile real pipeline wall-clock for video extractions.
 */
export const STALE_PENDING_MS = 5 * 60 * 1000;

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

/**
 * Run the full extraction pipeline for one source and cache the result in
 * EXTRACT_STATE KV keyed by content_hash.
 *
 * Idempotency: if a usable state already exists, do nothing. `done` and
 * `error` are terminal; `pending`/`partial` are honoured unless older than
 * STALE_PENDING_MS, in which case the worker that wrote them is presumed
 * dead and we re-run.
 *
 * The HTTP handler wraps this in `ctx.waitUntil` so the POST /extract
 * response can return immediately while the pipeline runs.
 */
export async function orchestrate(
  req: OrchestratorRequest,
  env: Env,
  ctx: WaitUntilCtx,
  deps: OrchestrateDeps = {},
): Promise<void> {
  // Per-share isolation scope: every log/error emitted inside this callback
  // is tagged with contentHash + source, so on a Sentry issue page you can
  // see "this is share X for IG/TikTok" without each call-site repeating it.
  // The scope is discarded when the callback returns, so concurrent shares
  // can't leak tags into each other's events.
  return Sentry.withIsolationScope(async () => {
    Sentry.setTag('contentHash', req.contentHash);
    await orchestrateImpl(req, env, ctx, deps);
  });
}

async function orchestrateImpl(
  req: OrchestratorRequest,
  env: Env,
  ctx: WaitUntilCtx,
  deps: OrchestrateDeps,
): Promise<void> {
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

  const runFetchPost = deps.runFetchPost ?? defaultRunFetchPost;
  const runExtract = deps.runExtract ?? defaultRunExtract;
  const searchAndDetails = deps.searchAndDetails ?? defaultSearchAndDetails;
  const buildBulkBlurb = deps.buildBulkBlurb ?? defaultBuildBulkBlurb;
  const fetchImageBase64 = deps.fetchImageBase64 ?? defaultFetchImageBase64;

  let fetched: FetchPostResponse;
  let cacheKind: 'og' | 'apify';
  const fetchStart = Date.now();
  logEvent({ event: 'stage_start', stage: 'fetch-post', contentHash: req.contentHash });
  try {
    const out = await runFetchPost(req.url, env);
    fetched = out.result;
    cacheKind = out.cacheKind;
  } catch (err) {
    logStageError(err, {
      stage: 'fetch-post',
      contentHash: req.contentHash,
      duration_ms: Date.now() - fetchStart,
      error_code: 'fetch-failed',
    });
    await writeState(
      { contentHash: req.contentHash, status: 'error', error: 'fetch-failed', startedAt },
      env,
    );
    return;
  }
  // Tag the isolation scope with the resolved platform so every downstream
  // event/error in this share has source=instagram|tiktok|... without each
  // call-site re-passing it.
  Sentry.setTag('source', fetched.platform);
  logEvent({
    event: 'stage_done',
    stage: 'fetch-post',
    contentHash: req.contentHash,
    source: fetched.platform,
    duration_ms: Date.now() - fetchStart,
    cache_kind: cacheKind,
  });

  await writeState(
    {
      contentHash: req.contentHash,
      status: 'partial',
      caption: fetched.caption,
      coverUrl: fetched.imageUrls[0],
      videoPresent: !!fetched.videoUrl,
      startedAt,
    },
    env,
  );

  const extractStart = Date.now();
  logEvent({
    event: 'stage_start',
    stage: 'extract',
    contentHash: req.contentHash,
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
      req.contentHash,
    );
  } catch (err) {
    // Transient: every Gemini call in the fallback chain failed with a
    // retryable upstream code (5xx / 429). Leave the existing `partial`
    // state in KV alone — fetch-post's caption + cover are still valid
    // for the triage card — and let the stale-pending recovery re-run
    // the pipeline on the next POST. handleExtractPost falls through
    // partial states (only done/error short-circuit), so the client's
    // next foreground sweep that hits the stale-pending threshold will
    // retrigger this orchestration with no manual user action.
    if (err instanceof TransientExtractError) {
      logEvent({
        event: 'orchestrate_extract_transient',
        contentHash: req.contentHash,
        source: fetched.platform,
        duration_ms: Date.now() - extractStart,
        detail: err.details,
      });
      return;
    }
    const code = err instanceof Error ? err.message : String(err);
    logStageError(err, {
      stage: 'extract',
      contentHash: req.contentHash,
      source: fetched.platform,
      duration_ms: Date.now() - extractStart,
      error_code: code === 'no-extractable-content' ? 'no-extractable-content' : 'extract-failed',
    });
    await writeState(
      {
        contentHash: req.contentHash,
        status: 'error',
        error: code === 'no-extractable-content' ? 'no-extractable-content' : 'extract-failed',
        caption: fetched.caption,
        coverUrl: fetched.imageUrls[0],
        videoPresent: !!fetched.videoUrl,
        startedAt,
      },
      env,
    );
    return;
  }
  logEvent({
    event: 'stage_done',
    stage: 'extract',
    contentHash: req.contentHash,
    source: fetched.platform,
    duration_ms: Date.now() - extractStart,
  });

  // Wrap enrichment because Promise.all over N Google Places lookups can
  // throw runtime exceptions the inner try/catches don't capture — most
  // notably Workers' "Too many subrequests by single Worker invocation"
  // when a carousel yields enough places that the cumulative subrequest
  // budget (50 on Workers Free, 1000 on Paid) is exhausted. Without this
  // wrap the throw escaped into ctx.waitUntil which swallowed it, leaving
  // state stuck at `partial`. Surfacing it as `enrich-failed` makes the
  // failure visible to the user and lets the source row flip to `failed`
  // instead of spinning.
  try {
    await enrichAndWriteDone(
      result,
      env,
      searchAndDetails,
      buildBulkBlurb,
      req,
      fetched,
      startedAt,
    );
  } catch (err) {
    logStageError(err, {
      stage: 'enrich',
      contentHash: req.contentHash,
      source: fetched.platform,
      error_code: 'enrich-failed',
    });
    await writeState(
      {
        contentHash: req.contentHash,
        status: 'error',
        error: 'enrich-failed',
        caption: fetched.caption,
        coverUrl: fetched.imageUrls[0],
        videoPresent: !!fetched.videoUrl,
        startedAt,
      },
      env,
    );
  }
}

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
 * generic Error so orchestrate can preserve the existing `partial` state
 * and let stale-pending recovery retry — instead of writing a terminal
 * `error` that the user sees as "couldn't read" with no auto-retry path.
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

async function enrichAndWriteDone(
  result: { places: ExtractedPlace[]; model: string },
  env: Env,
  searchAndDetails: SearchAndDetailsFn,
  buildBulkBlurb: BuildBulkBlurbFn,
  req: OrchestratorRequest,
  fetched: FetchPostResponse,
  startedAt: string,
): Promise<void> {
  const extractedDeduped = dedupePlaces(result.places);
  const enrichStart = Date.now();
  logEvent({
    event: 'stage_start',
    stage: 'enrich',
    contentHash: req.contentHash,
    source: fetched.platform,
    place_count: extractedDeduped.length,
  });

  // Enrich each place against Google Places in parallel. PlacesError per
  // place becomes "not-found" — the place still ships, just without the
  // enrichment fields. This is the same fallback the client uses today.
  const enrichmentInput = extractedDeduped.map((p, i) => ({
    place: p,
    enrichKey: `${i}`, // stable index id used during enrich-by-place_id dedup
  }));

  const detailsResults = await Promise.all(
    enrichmentInput.map(async (item) => {
      try {
        const details = await searchAndDetails(
          {
            name: item.place.name,
            city: item.place.city,
            address: item.place.address,
            ocr_caption: fetched.caption ?? '',
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
            contentHash: req.contentHash,
            source: fetched.platform,
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

  // Bulk-blurb only the items that have details (i.e. that Google Places
  // matched). For not-found rows we don't have anything grounded to write
  // a blurb against.
  const blurbInputs = survivors
    .filter((s): s is typeof s & { details: PlaceDetails } => s.details !== null)
    .map((s) => ({
      id: s.details.id,
      name: s.place.name,
      city: s.place.city,
      ocr_caption: fetched.caption ?? '',
      details: s.details,
    }));

  const enrichDuration = Date.now() - enrichStart;
  const matched = detailsResults.filter((d) => d.details !== null).length;
  logEvent({
    event: 'stage_done',
    stage: 'enrich',
    contentHash: req.contentHash,
    source: fetched.platform,
    duration_ms: enrichDuration,
    place_count: detailsResults.length,
    matched_count: matched,
  });

  // Defer bulk-blurb to client-driven per-place retries. Cloudflare's
  // `ctx.waitUntil` is capped at 30s wall-clock after the response is
  // sent (https://developers.cloudflare.com/workers/runtime-apis/context),
  // and an 8-slide / 20-place carousel can spend 25-28s on fetch-post +
  // vision + enrich before reaching this point. With <3s remaining the
  // runtime cancels the in-flight Gemini fetch mid-call and leaves state
  // stuck at `partial`, regardless of any Promise.race timeout we'd add
  // (the runtime tears down the isolate, not the JS frame, and races
  // against fetch-post's natural variability are inherently fragile).
  //
  // Instead: write `done` immediately with `blurb_status='failed'` on
  // every place. The client (modules/enrichment/enrichment.ts) already
  // polls those rows via /enrich, each retry in its own fresh worker
  // invocation with its own 30s budget. The source becomes usable right
  // away with all Google Places details; blurbs trickle in over the
  // next few seconds.
  logEvent({
    event: 'blurb_deferred',
    contentHash: req.contentHash,
    source: fetched.platform,
    place_count: blurbInputs.length,
  });
  // `buildBulkBlurb` stays in the dep map for signature stability across
  // tests and so it can be re-enabled if we ever move to a model where
  // the bulk call is cheap enough to fit inline.
  void buildBulkBlurb;
  const blurbsByPlaceId: Map<string, BlurbResult> = new Map();

  const enrichedPlaces: EnrichedPlace[] = survivors.map((s) => {
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
      // Missing entry = the bulk call returned nothing for this id, so we
      // treat it as 'failed' — client can /blurb-retry. Present entry
      // with outcome='empty' means the model abstained intentionally; no
      // retry. Present entry with outcome='ok' means we have a blurb.
      blurb_status: blurbResult ? blurbResult.outcome : 'failed',
    };
  });

  await writeState(
    {
      contentHash: req.contentHash,
      status: 'done',
      caption: fetched.caption,
      coverUrl: fetched.imageUrls[0],
      videoPresent: !!fetched.videoUrl,
      places: enrichedPlaces,
      model: result.model,
      startedAt,
    },
    env,
  );
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
