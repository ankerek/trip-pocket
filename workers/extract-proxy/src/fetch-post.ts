import { z } from 'zod';
import type { Env } from './index';
import { ApifyError, fetchInstagramViaApify } from './apify';
import { requireEntitlement } from './entitlement';

// Designed around the Phase 0 spike findings (docs/superpowers/specs/
// 2026-05-12-url-share-spike-results.md): IG's /embed/ surface moved to
// client-side rendering, so we fetch the canonical post URL and parse
// `og:*` meta tags. Same pattern is the primary path for TikTok, with
// oEmbed as a safety net.
//
// We do not download the cover image here — IG/TikTok cover URLs are
// public CDN endpoints; the phone fetches them directly to keep this
// worker stateless and small.

// --- Schemas -------------------------------------------------------------

export const fetchPostRequestSchema = z.object({
  url: z.string().url(),
});

export type FetchPostRequest = z.infer<typeof fetchPostRequestSchema>;

// Closed-vocab debug echo describing the worker's dispatch decision. The
// phone forwards these into the `url_fetch` stage's firehose extras so the
// pipeline-observability stream shows which path the worker took without
// having to context-switch to `wrangler tail`. See
// docs/superpowers/specs/2026-05-13-pipeline-observability-design.md
// §Worker debug echo.
export const fetchPostDebugSchema = z.object({
  route: z.enum([
    'og_only',
    'og_only_apify_disabled',
    'og_then_apify_carousel',
    'og_then_apify_unknown_efg',
    'og_failed_apify_fallback',
    'tiktok_rehyd_photo',
    'tiktok_rehyd_video',
    'tiktok_oembed_fallback',
  ]),
  ogOutcome: z.enum([
    'ok',
    'empty',
    'not_found',
    'private',
    'unsupported_url',
    'rate_limited',
    'timeout',
    'network',
    'upstream_5xx',
    'not_called',
  ]),
  apifyOutcome: z.enum([
    'not_called',
    'not_configured',
    'ok',
    'empty',
    'carousel_no_children',
    'auth',
    'actor_not_found',
    'rate_limited',
    'timeout',
    'network',
    'upstream',
    'non_json',
  ]),
  cacheHit: z.boolean(),
});

export type FetchPostDebug = z.infer<typeof fetchPostDebugSchema>;

export const fetchPostResponseSchema = z.object({
  platform: z.enum(['instagram', 'tiktok']),
  permalink: z.string().url(),
  caption: z.string(), // may be empty when the post had no caption
  imageUrls: z.array(z.string().url()), // may be empty when no cover is recoverable
  author: z.string().nullable(),
  _debug: fetchPostDebugSchema.optional(),
});

export type FetchPostResponse = z.infer<typeof fetchPostResponseSchema>;

// --- HTTP helpers --------------------------------------------------------

const JSON_HEADERS = { 'content-type': 'application/json' } as const;

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { ...JSON_HEADERS, ...(init.headers ?? {}) },
  });
}

function errorResponse(
  error: string,
  status: number,
  extra: Record<string, string> = {},
): Response {
  // Spec: error responses must never be cached. A transient Apify outage
  // (or rate-limited og: response) should not poison a URL for the full
  // success TTL. Callers that genuinely want caching set a different header
  // in `extra`.
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { 'cache-control': 'no-store', ...JSON_HEADERS, ...extra },
  });
}

// --- Public handler ------------------------------------------------------

export async function handleFetchPost(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return errorResponse('method-not-allowed', 405);

  const gate = await requireEntitlement(request, env);
  if (!gate.ok) return gate.response;

  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) {
    return errorResponse('content-type-must-be-json', 400);
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return errorResponse('invalid-json', 400);
  }
  const parsed = fetchPostRequestSchema.safeParse(raw);
  if (!parsed.success) return errorResponse('invalid-request-body', 400);

  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  const { success: rateOk } = await env.RATE_LIMIT.limit({ key: ip });
  if (!rateOk) return errorResponse('rate-limited', 429, { 'retry-after': '60' });

  let target: URL;
  try {
    target = new URL(parsed.data.url);
  } catch {
    return errorResponse('unsupported-url', 400);
  }
  const platform = detectPlatform(target);
  if (!platform) return errorResponse('unsupported-url', 400);

  try {
    let result: FetchPostResponse;
    let cacheKind: 'og' | 'apify' = 'og';
    let dispatch: Omit<FetchPostDebug, 'cacheHit'>;
    if (platform === 'instagram') {
      const out = await fetchInstagram(target, env);
      result = out.result;
      cacheKind = out.cacheKind;
      dispatch = out.dispatch;
    } else {
      const out = await fetchTikTok(target);
      result = out.result;
      dispatch = out.dispatch;
    }
    // cacheHit stays `false` while the worker uses Cache-Control headers only
    // (CF edge caches the response but the worker doesn't re-run on hits, so
    // there is no per-request signal here). Promoting cacheHit to `true` would
    // require an explicit `caches.default.match()` integration — out of scope
    // for v1 of the debug echo.
    result._debug = { ...dispatch, cacheHit: false };
    // Spec: 7d cache when Apify fired, 1d for og-only. Both only on success;
    // errors get Cache-Control: no-store (handled in fetchErrorToResponse).
    const sMaxAge = cacheKind === 'apify' ? 604800 : 86400;
    return jsonResponse(result, {
      headers: { 'cache-control': `public, s-maxage=${sMaxAge}` },
    });
  } catch (err) {
    return fetchErrorToResponse(err);
  }
}

function ogOutcomeFromError(err: UpstreamError): FetchPostDebug['ogOutcome'] {
  switch (err.code) {
    case 'unsupported-url':
      return 'unsupported_url';
    case 'not-found':
      return 'not_found';
    case 'private':
      return 'private';
    case 'fetch-failed-timeout':
      return 'timeout';
    case 'fetch-failed-network':
      return 'network';
    case 'fetch-failed-rate-limit':
      return 'rate_limited';
    case 'fetch-failed-upstream':
    case 'fetch-failed':
    default:
      return 'upstream_5xx';
  }
}

// --- Platform detection / URL canonicalisation ---------------------------

export function detectPlatform(url: URL): 'instagram' | 'tiktok' | null {
  const host = url.hostname.toLowerCase().replace(/^(www\.|m\.)/, '');
  if (host === 'instagram.com' || host === 'instagr.am') return 'instagram';
  if (host === 'tiktok.com' || host === 'vm.tiktok.com' || host === 'vt.tiktok.com') {
    return 'tiktok';
  }
  return null;
}

// --- HTML entity decoding ------------------------------------------------

export function decodeHtmlEntities(s: string): string {
  // Numeric (decimal and hex) HTML entities plus the most common named ones.
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
}

function safeCodePoint(n: number): string {
  if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return '';
  try {
    return String.fromCodePoint(n);
  } catch {
    return '';
  }
}

// --- og:* parsing --------------------------------------------------------

export function findOgMeta(html: string, prop: string): string | null {
  // Two attribute orderings: property-first or content-first. Cover both.
  const reA = new RegExp(
    `<meta[^>]+property=["']${escapeRegex(prop)}["'][^>]+content=["']([^"']*)["']`,
    'i',
  );
  const reB = new RegExp(
    `<meta[^>]+content=["']([^"']*)["'][^>]+property=["']${escapeRegex(prop)}["']`,
    'i',
  );
  const m = html.match(reA) ?? html.match(reB);
  return m?.[1] ?? null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// --- Instagram fetcher ---------------------------------------------------

// Spike-verified: canonical post URL returns full og: tags. /embed/ is now
// a JS shell with no static post data.
const IG_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) ' +
  'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
const FETCH_TIMEOUT_MS = 10000;

class UpstreamError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
  ) {
    super(`${code} (${status})`);
    this.name = 'UpstreamError';
  }
}

type InstagramDispatch = Omit<FetchPostDebug, 'cacheHit'>;

async function fetchInstagram(
  target: URL,
  env: Env,
): Promise<{
  result: FetchPostResponse;
  cacheKind: 'og' | 'apify';
  dispatch: InstagramDispatch;
}> {
  const shortcode = parseInstagramShortcode(target);
  if (!shortcode) throw new UpstreamError(400, 'unsupported-url');
  const canonical = `https://www.instagram.com/p/${shortcode}/`;
  const urlShape = parseInstagramUrlShape(target); // 'p' | 'reel' | 'tv'

  // Stage 1: og: parse on canonical URL. Always runs (free, fast). For /reel/
  // and /tv/ URLs the og: result is final; for /p/ URLs the efg hint decides
  // whether Stage 2 fires.
  let ogResult: FetchPostResponse | null = null;
  let ogError: UpstreamError | null = null;
  try {
    ogResult = await fetchInstagramOg(canonical);
  } catch (err) {
    if (err instanceof UpstreamError) ogError = err;
    else throw err;
  }
  const ogOutcome: FetchPostDebug['ogOutcome'] = ogResult
    ? 'ok'
    : ogError
      ? ogOutcomeFromError(ogError)
      : 'upstream_5xx';

  // /reel/ and /tv/ never go to Apify on success.
  if (urlShape !== 'p' && ogResult) {
    return {
      result: ogResult,
      cacheKind: 'og',
      dispatch: { route: 'og_only', ogOutcome, apifyOutcome: 'not_called' },
    };
  }

  // /p/ posts: use the efg hint to decide. Treat unknown/missing as carousel
  // (extraction quality wins over marginal cost — see spec).
  const efgType = ogResult ? decodeEfgFromImageUrl(ogResult.imageUrls[0] ?? '') : null;
  const shouldFireApify = !ogResult || efgType !== 'single';
  if (!shouldFireApify && ogResult) {
    return {
      result: ogResult,
      cacheKind: 'og',
      dispatch: { route: 'og_only', ogOutcome, apifyOutcome: 'not_called' },
    };
  }

  // Soft-degrade: if Apify isn't configured, ship the og: result when we have
  // one (carousel loses slides 2..N — matches v0.2.1 behavior pre-Apify).
  // This lets us deploy without an APIFY_TOKEN and add it later without a
  // code change. og:-failed + no-Apify surfaces the original og: error.
  const apifyConfigured = Boolean(env.APIFY_TOKEN && env.APIFY_ACTOR_ID);
  if (!apifyConfigured) {
    if (ogResult) {
      return {
        result: ogResult,
        cacheKind: 'og',
        dispatch: {
          route: 'og_only_apify_disabled',
          ogOutcome,
          apifyOutcome: 'not_configured',
        },
      };
    }
    if (ogError) throw ogError;
    throw new UpstreamError(502, 'fetch-failed');
  }

  // Decide the route label up front so the failure path can report the same
  // intent the success path would have. Carousel vs unknown_efg vs fallback —
  // not mutually exclusive with og-success/og-failure, just labels.
  const route: FetchPostDebug['route'] = !ogResult
    ? 'og_failed_apify_fallback'
    : efgType === 'carousel'
      ? 'og_then_apify_carousel'
      : 'og_then_apify_unknown_efg';

  // Stage 2: Apify. Authoritative when it fires.
  try {
    const apify = await fetchInstagramViaApify(canonical, {
      token: env.APIFY_TOKEN ?? '',
      actorId: env.APIFY_ACTOR_ID ?? '',
    });
    return {
      result: {
        platform: 'instagram',
        permalink: apify.permalink || canonical,
        caption: apify.caption,
        imageUrls: apify.imageUrls,
        author: apify.author,
      },
      cacheKind: 'apify',
      dispatch: { route, ogOutcome, apifyOutcome: 'ok' },
    };
  } catch (err) {
    if (err instanceof ApifyError) {
      // Surface the specific Apify failure to Workers logs (apify-auth /
      // apify-empty / apify-rate-limited / apify-timeout / apify-upstream)
      // so `wrangler tail` shows what actually went wrong. The client
      // response stays generic — same reasoning as the rest of the proxy.
      console.error('extract-proxy/fetch-post: apify-failed', err.code, err.status);
      if (ogResult) throw new UpstreamError(502, 'fetch-failed');
      if (ogError) throw ogError;
      throw new UpstreamError(502, 'fetch-failed');
    }
    if (ogError) throw ogError;
    throw err;
  }
}

async function fetchInstagramOg(canonical: string): Promise<FetchPostResponse> {
  const html = await fetchHtml(canonical, IG_UA);

  const captionRaw = findOgMeta(html, 'og:description');
  const imageRaw = findOgMeta(html, 'og:image');
  const titleRaw = findOgMeta(html, 'og:title');

  if (!captionRaw && !imageRaw) {
    // Nothing useful came back — likely a soft block or a deleted post.
    throw new UpstreamError(502, 'fetch-failed');
  }

  const caption = captionRaw ? decodeHtmlEntities(captionRaw) : '';
  const cover = imageRaw ? decodeHtmlEntities(imageRaw) : null;
  const author = extractAuthorFromIgTitle(titleRaw);

  return {
    platform: 'instagram',
    permalink: canonical,
    caption,
    imageUrls: cover ? [cover] : [],
    author,
  };
}

export function parseInstagramUrlShape(url: URL): 'p' | 'reel' | 'tv' | null {
  const m = url.pathname.match(/^\/(p|reel|tv)\//);
  return (m?.[1] as 'p' | 'reel' | 'tv' | undefined) ?? null;
}

/**
 * IG embeds a base64-encoded JSON object in the `efg` query param on
 * `og:image` URLs. The decoded object carries a `media_type` token we use
 * to cheaply classify a post as single vs carousel vs reel without paying
 * Apify. Returns null on any decode failure (treated as 'unknown' upstream).
 */
export function decodeEfgFromImageUrl(imageUrl: string): 'single' | 'carousel' | 'clips' | null {
  if (!imageUrl) return null;
  let efg: string | null = null;
  try {
    const u = new URL(imageUrl);
    efg = u.searchParams.get('efg');
  } catch {
    return null;
  }
  if (!efg) return null;
  let decoded: string;
  try {
    // efg is URL-safe base64, no padding. atob is available in Workers.
    const padded = efg + '='.repeat((4 - (efg.length % 4)) % 4);
    decoded = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
  } catch {
    return null;
  }
  // Decoded payload is JSON-ish, e.g.
  // {"media_type":"CAROUSEL_ITEM","..."}. We pattern-match rather than full
  // JSON.parse — the field is reliably present and stringly-typed.
  const m = decoded.match(/"media_type"\s*:\s*"([A-Za-z_]+)"/);
  const token = m?.[1];
  if (token === 'CAROUSEL_ITEM') return 'carousel';
  if (token === 'CLIPS') return 'clips';
  if (token === 'GraphImage' || token === 'Image' || token === 'PHOTO') return 'single';
  // Some posts use a different token; the spec routes any non-single to Apify.
  return null;
}

export function parseInstagramShortcode(url: URL): string | null {
  // Accepted shapes: /p/<id>/, /reel/<id>/, /tv/<id>/
  const m = url.pathname.match(/^\/(?:p|reel|tv)\/([A-Za-z0-9_-]+)\/?/);
  return m?.[1] ?? null;
}

export function extractAuthorFromIgTitle(title: string | null): string | null {
  if (!title) return null;
  const decoded = decodeHtmlEntities(title);
  // IG og:title format: "<Display Name> on Instagram: "..."" — take prefix.
  const idx = decoded.indexOf(' on Instagram:');
  if (idx > 0) return decoded.slice(0, idx).trim();
  // Reels sometimes: "<Display Name> on Instagram"
  const idxAlt = decoded.indexOf(' on Instagram');
  if (idxAlt > 0) return decoded.slice(0, idxAlt).trim();
  return null;
}

// --- TikTok fetcher ------------------------------------------------------

async function fetchTikTok(
  target: URL,
): Promise<{ result: FetchPostResponse; dispatch: Omit<FetchPostDebug, 'cacheHit'> }> {
  // Resolve short links so we end up on the canonical /@user/video/<id> or
  // /@user/photo/<id>. On HEAD failure the original URL is reused; the
  // parser will likely fail and oEmbed will fire (and resolves redirects itself).
  const canonical = await resolveTikTokCanonical(target);

  // Stage 1: rehydration JSON parse. og:* meta tags are no longer present on
  // TikTok pages, so this is the primary path. See
  // docs/superpowers/specs/2026-05-13-tiktok-slideshow-parsing-design.md.
  let primaryError: UpstreamError | null = null;
  try {
    const html = await fetchHtml(canonical.toString(), IG_UA);
    const data = extractTikTokRehydrationJson(html);
    const mapped = mapTikTokRehydrationItem(data, canonical.toString());
    const { _route, ...result } = mapped;
    console.log(
      'extract-proxy/tiktok-rehyd: ok',
      `type=${_route}`,
      `slides=${result.imageUrls.length}`,
      `captionLen=${result.caption.length}`,
    );
    return {
      result,
      dispatch: {
        route: _route === 'photo' ? 'tiktok_rehyd_photo' : 'tiktok_rehyd_video',
        ogOutcome: 'ok',
        apifyOutcome: 'not_called',
      },
    };
  } catch (err) {
    if (err instanceof UpstreamError) {
      primaryError = err;
      console.log('extract-proxy/tiktok-rehyd: fallback', `reason=${rehydReasonForLog(err)}`);
    } else {
      throw err;
    }
  }

  // Stage 2: oEmbed fallback. Officially documented; the safety net when the
  // rehydration parser fails for any reason (anti-bot stub, schema drift,
  // deleted post, transient HTTP error).
  try {
    const result = await fetchTikTokOEmbed(canonical);
    return {
      result,
      dispatch: {
        route: 'tiktok_oembed_fallback',
        ogOutcome: ogOutcomeFromRehydError(primaryError),
        apifyOutcome: 'not_called',
      },
    };
  } catch (oembedErr) {
    console.error(
      'extract-proxy/tiktok: total-failure',
      `primary=${ogOutcomeFromRehydError(primaryError)}`,
      `oembed=${oembedErr instanceof UpstreamError ? ogOutcomeFromError(oembedErr) : 'network'}`,
      `url_shape=${parseTikTokUrlShape(target)}`,
    );
    throw oembedErr;
  }
}

function rehydReasonForLog(err: UpstreamError): string {
  if (
    err.code === 'tiktok-no-rehydration' ||
    err.code === 'tiktok-rehyd-non-json' ||
    err.code === 'tiktok-rehyd-no-item'
  ) {
    return err.code.replace(/^tiktok-(rehyd-)?/, '');
  }
  // HTTP-level error codes from fetchHtml — keep them as-is for grep.
  return err.code;
}

function ogOutcomeFromRehydError(err: UpstreamError | null): FetchPostDebug['ogOutcome'] {
  if (!err) return 'empty';
  // Parser-level failures (blob missing / malformed / item missing) all map
  // to "primary returned nothing usable" — closed-vocab `empty`.
  if (
    err.code === 'tiktok-no-rehydration' ||
    err.code === 'tiktok-rehyd-non-json' ||
    err.code === 'tiktok-rehyd-no-item'
  ) {
    return 'empty';
  }
  return ogOutcomeFromError(err);
}

function parseTikTokUrlShape(url: URL): 'photo' | 'video' | 'short' | 'other' {
  const host = url.hostname.toLowerCase().replace(/^(www\.|m\.)/, '');
  if (host === 'vm.tiktok.com' || host === 'vt.tiktok.com') return 'short';
  if (/^\/@[^/]+\/photo\//.test(url.pathname)) return 'photo';
  if (/^\/@[^/]+\/video\//.test(url.pathname)) return 'video';
  return 'other';
}

async function resolveTikTokCanonical(target: URL): Promise<URL> {
  const host = target.hostname.toLowerCase().replace(/^(www\.|m\.)/, '');
  if (host !== 'vm.tiktok.com' && host !== 'vt.tiktok.com') return target;
  // HEAD-follow the redirect chain.
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let resp: Response;
  try {
    resp = await fetch(target.toString(), {
      method: 'HEAD',
      redirect: 'follow',
      headers: { 'User-Agent': IG_UA },
      signal: controller.signal,
    });
  } catch {
    return target; // Best effort; downstream still has a chance.
  } finally {
    clearTimeout(t);
  }
  try {
    return new URL(resp.url);
  } catch {
    return target;
  }
}

async function fetchTikTokOEmbed(canonical: URL): Promise<FetchPostResponse> {
  const url = `https://www.tiktok.com/oembed?url=${encodeURIComponent(canonical.toString())}`;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': IG_UA, Accept: 'application/json' },
      signal: controller.signal,
    });
  } catch (err) {
    throw new UpstreamError(504, 'fetch-failed-timeout');
  } finally {
    clearTimeout(t);
  }

  if (resp.status === 404) throw new UpstreamError(404, 'not-found');
  if (resp.status === 403) throw new UpstreamError(403, 'private');
  if (!resp.ok) throw new UpstreamError(502, 'fetch-failed');

  let body: unknown;
  try {
    body = await resp.json();
  } catch {
    throw new UpstreamError(502, 'fetch-failed');
  }
  const b = body as {
    title?: string;
    thumbnail_url?: string;
    author_name?: string;
  };
  return {
    platform: 'tiktok',
    permalink: canonical.toString(),
    caption: typeof b.title === 'string' ? b.title : '',
    imageUrls:
      typeof b.thumbnail_url === 'string' && b.thumbnail_url.length > 0 ? [b.thumbnail_url] : [],
    author:
      typeof b.author_name === 'string' && b.author_name.length > 0
        ? `@${b.author_name}`
        : extractAuthorFromTikTokUrl(canonical),
  };
}

export function extractAuthorFromTikTokUrl(url: URL): string | null {
  // /@handle/video/<id> or /@handle/photo/<id> — TikTok slideshows live under
  // /photo/ and the regex used to silently miss them.
  const m = url.pathname.match(/^\/@([^/]+)\/(?:video|photo)\//);
  return m ? `@${m[1]}` : null;
}

export function extractAuthorFromTikTokTitle(title: string | null): string | null {
  if (!title) return null;
  const decoded = decodeHtmlEntities(title);
  const idx = decoded.indexOf(' on TikTok');
  if (idx > 0) return decoded.slice(0, idx).trim();
  return null;
}

// --- TikTok rehydration parser -------------------------------------------

// TikTok embeds the full post payload as a JSON-typed <script> tag in the
// static HTML. og:* meta tags are no longer present on TikTok pages (as of
// 2026-05), so this is the primary extraction path; oEmbed is the fallback
// when this fails (anti-bot stub, schema drift, deleted post).
//
// See docs/superpowers/specs/2026-05-13-tiktok-slideshow-parsing-design.md.

const TIKTOK_REHYD_RE =
  /<script\s+id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]+?)<\/script>/;

export function extractTikTokRehydrationJson(html: string): unknown {
  const m = html.match(TIKTOK_REHYD_RE);
  if (!m || !m[1]) throw new UpstreamError(502, 'tiktok-no-rehydration');
  try {
    return JSON.parse(m[1]);
  } catch {
    throw new UpstreamError(502, 'tiktok-rehyd-non-json');
  }
}

export type MappedTikTokItem = FetchPostResponse & {
  _route: 'photo' | 'video';
};

export function mapTikTokRehydrationItem(raw: unknown, canonical: string): MappedTikTokItem {
  // Field path:
  //   __DEFAULT_SCOPE__
  //     .webapp.reflow.video.detail
  //     .itemInfo.itemStruct
  // Same route is used for both /photo/ and /video/ URLs; `imagePost`'s
  // presence inside `itemStruct` is the photo-vs-video discriminator.
  const scope = getProp(raw, '__DEFAULT_SCOPE__');
  const detail = getProp(scope, 'webapp.reflow.video.detail');
  const itemInfo = getProp(detail, 'itemInfo');
  const item = getProp(itemInfo, 'itemStruct');
  if (!isObject(item)) throw new UpstreamError(502, 'tiktok-rehyd-no-item');

  const caption = asString(getProp(item, 'desc')) ?? '';
  const uniqueId = asString(getProp(getProp(item, 'author'), 'uniqueId'));
  const author = uniqueId && uniqueId.length > 0 ? `@${uniqueId}` : null;

  const imagePost = getProp(item, 'imagePost');
  if (isObject(imagePost)) {
    const images = getProp(imagePost, 'images');
    const imageUrls: string[] = [];
    if (Array.isArray(images)) {
      for (const img of images) {
        const urlList = getProp(getProp(img, 'imageURL'), 'urlList');
        if (Array.isArray(urlList)) {
          const u = asString(urlList[0]);
          if (u && u.length > 0) imageUrls.push(u);
        }
      }
    }
    return {
      platform: 'tiktok',
      permalink: canonical,
      caption,
      imageUrls,
      author,
      _route: 'photo',
    };
  }

  const cover = asString(getProp(getProp(item, 'video'), 'cover'));
  const imageUrls = cover && cover.length > 0 ? [cover] : [];
  return {
    platform: 'tiktok',
    permalink: canonical,
    caption,
    imageUrls,
    author,
    _route: 'video',
  };
}

function getProp(o: unknown, key: string): unknown {
  if (isObject(o) && key in o) return (o as Record<string, unknown>)[key];
  return undefined;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

// --- Shared HTML fetch ---------------------------------------------------

async function fetchHtml(url: string, userAgent: string): Promise<string> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        'User-Agent': userAgent,
        'Accept-Language': 'en-US,en;q=0.9',
        Accept: 'text/html,application/xhtml+xml',
      },
      signal: controller.signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new UpstreamError(504, 'fetch-failed-timeout');
    }
    throw new UpstreamError(502, 'fetch-failed-network');
  } finally {
    clearTimeout(t);
  }

  if (resp.status === 404) throw new UpstreamError(404, 'not-found');
  if (resp.status === 403 || resp.status === 401) {
    throw new UpstreamError(403, 'private');
  }
  if (resp.status === 429) throw new UpstreamError(429, 'fetch-failed-rate-limit');
  if (resp.status >= 500) throw new UpstreamError(502, 'fetch-failed-upstream');
  if (!resp.ok) throw new UpstreamError(502, 'fetch-failed');

  return resp.text();
}

function fetchErrorToResponse(err: unknown): Response {
  if (err instanceof UpstreamError) {
    return errorResponse(err.code, err.status === 429 ? 502 : err.status);
  }
  console.error('extract-proxy/fetch-post: unexpected', String(err));
  return errorResponse('fetch-failed', 502);
}
