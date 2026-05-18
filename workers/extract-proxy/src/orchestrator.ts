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
  const existing = await readState(req.contentHash, env);
  if (existing && (existing.status === 'done' || existing.status === 'error')) return;
  if (existing && (existing.status === 'pending' || existing.status === 'partial')) {
    const startedAt = existing.startedAt ? Date.parse(existing.startedAt) : 0;
    const age = Date.now() - startedAt;
    if (Number.isFinite(age) && age < STALE_PENDING_MS) return;
    console.warn(
      'orchestrate: re-running stale state',
      'hash=' + req.contentHash,
      'status=' + existing.status,
      'ageMs=' + age,
    );
  }

  const startedAt = new Date().toISOString();
  await writeState({ contentHash: req.contentHash, status: 'pending', startedAt }, env);

  const runFetchPost = deps.runFetchPost ?? defaultRunFetchPost;
  const runExtract = deps.runExtract ?? defaultRunExtract;
  const searchAndDetails = deps.searchAndDetails ?? defaultSearchAndDetails;
  const buildBulkBlurb = deps.buildBulkBlurb ?? defaultBuildBulkBlurb;
  const fetchImageBase64 = deps.fetchImageBase64 ?? defaultFetchImageBase64;

  let fetched: FetchPostResponse;
  try {
    const out = await runFetchPost(req.url, env);
    fetched = out.result;
  } catch (err) {
    console.error('orchestrate: fetch failed', String(err));
    await writeState(
      { contentHash: req.contentHash, status: 'error', error: 'fetch-failed', startedAt },
      env,
    );
    return;
  }

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

  let result: { places: ExtractedPlace[]; model: string };
  try {
    result = await tryExtractWithFallback(fetched, env, ctx, runExtract, fetchImageBase64);
  } catch (err) {
    const code = err instanceof Error ? err.message : String(err);
    console.error('orchestrate: all extract modes failed', code);
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

  await enrichAndWriteDone(result, env, searchAndDetails, buildBulkBlurb, req, fetched, startedAt);
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
async function tryExtractWithFallback(
  fetched: FetchPostResponse,
  env: Env,
  ctx: WaitUntilCtx,
  runExtract: RunExtractFn,
  fetchImageBase64: (url: string) => Promise<string>,
): Promise<{ places: ExtractedPlace[]; model: string }> {
  const errors: string[] = [];

  // Skip video mode for TikTok: their CDN blocks Cloudflare Workers' egress
  // IPs (residential-IP enforcement), so every video-bytes fetch 403s. We
  // still get the caption + cover via rehydration parsing on the page HTML
  // (which IS reachable), and vision mode extracts places from those just
  // fine. Skipping saves ~500ms–1s of guaranteed-fail HTTP roundtrip per
  // TikTok share. Revert this guard if TikTok ever relaxes their CDN
  // policy (re-shares will start succeeding via the next-best path
  // regardless, so this isn't urgent to discover).
  if (fetched.videoUrl && fetched.platform !== 'tiktok') {
    try {
      return await runExtract(
        {
          mode: 'video',
          video: {
            url: fetched.videoUrl,
            durationSec: fetched.videoDuration ?? undefined,
            refererUrl: fetched.permalink,
          },
          caption: fetched.caption,
        },
        env,
        ctx,
      );
    } catch (err) {
      const code = err instanceof RunExtractError ? err.code : String(err);
      console.warn('orchestrate: video-mode failed, falling back', code);
      errors.push('video:' + code);
    }
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
        console.warn(
          'orchestrate: carousel slide fetch failed',
          'idx=' + i,
          'count=' + fetched.imageUrls.length,
          code,
        );
      }
    }
    if (imageBase64.length > 0) {
      try {
        return await runExtract(
          { mode: 'vision', imageBase64, caption: fetched.caption },
          env,
          ctx,
        );
      } catch (err) {
        const code = err instanceof Error ? err.message : String(err);
        console.warn('orchestrate: vision-mode failed, falling back', code);
        errors.push('vision:' + code);
      }
    } else {
      errors.push('vision:image-fetch-all-failed');
    }
  }

  if (fetched.caption.trim().length > 0) {
    try {
      return await runExtract({ mode: 'text', text: fetched.caption }, env, ctx);
    } catch (err) {
      const code = err instanceof RunExtractError ? err.code : String(err);
      console.warn('orchestrate: text-mode failed', code);
      errors.push('text:' + code);
    }
  }

  if (errors.length === 0) throw new Error('no-extractable-content');
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
          console.warn('orchestrate: places lookup failed', item.place.name, err.status);
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

  let blurbsByPlaceId: Map<string, BlurbResult>;
  try {
    blurbsByPlaceId = await buildBulkBlurb(blurbInputs, env);
  } catch (err) {
    console.warn('orchestrate: bulk blurb threw', String(err));
    blurbsByPlaceId = new Map();
  }

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
