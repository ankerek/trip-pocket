import type { Env } from './index';
import type {
  OrchestratorRequest,
  OrchestratorState,
  EnrichedPlace,
} from './orchestrator-schema';
import type { WaitUntilCtx } from './video';
import type { RequestBody, ExtractedPlace } from './schema';
import { runFetchPost as defaultRunFetchPost } from './fetch-post';
import { runExtract as defaultRunExtract } from './index';
import type { FetchPostResponse } from './fetch-post';
import { dedupePlaces } from './dedupe';
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
  req: { name: string; city: string; address: string; ocr_caption: string; extracted_place_id: string },
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

export async function readState(
  hash: string,
  env: Env,
): Promise<OrchestratorState | null> {
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
  await writeState(
    { contentHash: req.contentHash, status: 'pending', startedAt },
    env,
  );

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

  let extractBody: RequestBody;
  if (fetched.videoUrl) {
    extractBody = {
      mode: 'video',
      video: {
        url: fetched.videoUrl,
        durationSec: fetched.videoDuration ?? undefined,
        // Use the canonical post URL as Referer for the CDN fetch.
        // TikTok's CDN rejects playAddr URLs that don't carry the
        // per-video page URL here; IG's videoUrl historically tolerates
        // homepage Referer but the per-post URL is friendlier.
        refererUrl: fetched.permalink,
      },
      caption: fetched.caption,
    };
  } else if (fetched.imageUrls.length > 0) {
    let imageBase64: string;
    try {
      imageBase64 = await fetchImageBase64(fetched.imageUrls[0]!);
    } catch (err) {
      console.error('orchestrate: cover fetch failed', String(err));
      // Soft-degrade: drop to text mode using the caption if we have one.
      if (fetched.caption.trim().length > 0) {
        extractBody = { mode: 'text', text: fetched.caption };
      } else {
        await writeState(
          {
            contentHash: req.contentHash,
            status: 'error',
            error: 'no-extractable-content',
            caption: fetched.caption,
            startedAt,
          },
          env,
        );
        return;
      }
      await runExtractAndWriteDone(
        extractBody,
        env,
        ctx,
        runExtract,
        searchAndDetails,
        buildBulkBlurb,
        req,
        fetched,
        startedAt,
      );
      return;
    }
    extractBody = { mode: 'vision', imageBase64, caption: fetched.caption };
  } else if (fetched.caption.trim().length > 0) {
    extractBody = { mode: 'text', text: fetched.caption };
  } else {
    await writeState(
      {
        contentHash: req.contentHash,
        status: 'error',
        error: 'no-extractable-content',
        startedAt,
      },
      env,
    );
    return;
  }

  await runExtractAndWriteDone(
    extractBody,
    env,
    ctx,
    runExtract,
    searchAndDetails,
    buildBulkBlurb,
    req,
    fetched,
    startedAt,
  );
}

async function runExtractAndWriteDone(
  extractBody: RequestBody,
  env: Env,
  ctx: WaitUntilCtx,
  runExtract: RunExtractFn,
  searchAndDetails: SearchAndDetailsFn,
  buildBulkBlurb: BuildBulkBlurbFn,
  req: OrchestratorRequest,
  fetched: FetchPostResponse,
  startedAt: string,
): Promise<void> {
  let result: { places: ExtractedPlace[]; model: string };
  try {
    result = await runExtract(extractBody, env, ctx);
  } catch (err) {
    console.error('orchestrate: extract failed', String(err));
    await writeState(
      {
        contentHash: req.contentHash,
        status: 'error',
        error: 'extract-failed',
        caption: fetched.caption,
        coverUrl: fetched.imageUrls[0],
        videoPresent: !!fetched.videoUrl,
        startedAt,
      },
      env,
    );
    return;
  }

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
