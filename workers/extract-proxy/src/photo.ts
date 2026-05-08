import type { Env } from './index';

// Worker-proxied Google Places photo. The Places media URL embeds the
// API key as a query param, so returning it to clients would leak the
// server credential. We fetch upstream with the key and stream the body
// back. Cloudflare's edge cache absorbs repeats per PoP.

// Defense against open-redirect / SSRF: the path must look like
// `places/<placeId>/photos/<photoId>`. Both segments are
// alphanumeric/hyphen/underscore in practice; we accept a generous
// character class and rely on Google to reject anything else.
const PHOTO_NAME_RE = /^places\/[A-Za-z0-9_-]+\/photos\/[A-Za-z0-9_-]+$/;

const MAX_DIMENSION = 4800;
const MIN_DIMENSION = 1;
const DEFAULT_MAX_DIMENSION = 1200;

const CACHE_HEADERS = {
  // 30 days. The photo_name resource is durable for the venue per Google's
  // contract; if we ever see staleness in production, lower this.
  'cache-control': 'public, max-age=2592000, immutable',
} as const;

export async function handlePhoto(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response(JSON.stringify({ error: 'method-not-allowed' }), {
      status: 405,
      headers: { 'content-type': 'application/json' },
    });
  }

  if (!env.GOOGLE_PLACES_API_KEY) {
    console.error('extract-proxy/photo: GOOGLE_PLACES_API_KEY missing');
    return new Response(JSON.stringify({ error: 'server-misconfigured' }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
  }

  const url = new URL(request.url);
  // Path is /photo/<photo_name>. The photo_name itself contains slashes,
  // so we slice the prefix and treat the rest verbatim.
  const PREFIX = '/photo/';
  if (!url.pathname.startsWith(PREFIX)) {
    return new Response(JSON.stringify({ error: 'bad-path' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }
  const photoName = url.pathname.slice(PREFIX.length);
  if (!PHOTO_NAME_RE.test(photoName)) {
    return new Response(JSON.stringify({ error: 'invalid-photo-name' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }

  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  const { success: rateOk } = await env.RATE_LIMIT.limit({ key: ip });
  if (!rateOk) {
    return new Response(JSON.stringify({ error: 'rate-limited' }), {
      status: 429,
      headers: { 'content-type': 'application/json', 'retry-after': '60' },
    });
  }

  const maxW = clampDimension(url.searchParams.get('w'), DEFAULT_MAX_DIMENSION);
  const maxH = clampDimension(url.searchParams.get('h'), DEFAULT_MAX_DIMENSION);

  const upstream = new URL(`https://places.googleapis.com/v1/${photoName}/media`);
  upstream.searchParams.set('key', env.GOOGLE_PLACES_API_KEY);
  upstream.searchParams.set('maxWidthPx', String(maxW));
  upstream.searchParams.set('maxHeightPx', String(maxH));
  upstream.searchParams.set('skipHttpRedirect', 'false');

  let upstreamResp: Response;
  try {
    upstreamResp = await fetch(upstream.toString(), { method: request.method });
  } catch (err) {
    console.error('extract-proxy/photo: upstream-network', String(err));
    return new Response(JSON.stringify({ error: 'upstream-network-error' }), {
      status: 502,
      headers: { 'content-type': 'application/json' },
    });
  }

  if (upstreamResp.status === 404) {
    return new Response(JSON.stringify({ error: 'photo-not-found' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  }
  if (!upstreamResp.ok) {
    console.error('extract-proxy/photo: upstream', upstreamResp.status);
    return new Response(JSON.stringify({ error: 'upstream-error' }), {
      status: 502,
      headers: { 'content-type': 'application/json' },
    });
  }

  // Pass through the body and content-type. Strip cookies / Google internal
  // headers; set our own cache header so Cloudflare's edge cache holds it.
  const headers = new Headers();
  const ct = upstreamResp.headers.get('content-type');
  if (ct) headers.set('content-type', ct);
  const cl = upstreamResp.headers.get('content-length');
  if (cl) headers.set('content-length', cl);
  for (const [k, v] of Object.entries(CACHE_HEADERS)) headers.set(k, v);

  return new Response(upstreamResp.body, {
    status: 200,
    headers,
  });
}

function clampDimension(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  if (n < MIN_DIMENSION) return MIN_DIMENSION;
  if (n > MAX_DIMENSION) return MAX_DIMENSION;
  return n;
}
