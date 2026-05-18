// Video-mode helper for /extract. Fetches the CDN video URL directly,
// then either inlines the bytes (`inline_data`) or uploads via Gemini's
// Files API and references the resulting URI (`file_data`).
//
// Spec: docs/superpowers/specs/2026-05-16-video-place-extraction-design.md
//
// Files API uploads bypass AI Gateway (file lifecycle is not a generative
// request); the actual `generateContent` call still flows through the
// gateway in handleExtract.

const FETCH_TIMEOUT_MS = 20_000;

// Hard cap on response body size — defense for the 128 MB Worker isolate
// memory limit. 25 MB raw + ~33 MB base64 + a few MB JSON envelope.
export const MAX_VIDEO_BYTES = 25 * 1024 * 1024;

// Cutoff between inline and Files API transports. Gemini docs say inline
// tops out at 20 MB total request size; we keep some headroom for the JSON
// envelope (caption, system prompt, response schema) by cutting at 18 MB.
export const INLINE_TRANSPORT_CUTOFF_BYTES = 18 * 1024 * 1024;

// Hard duration ceiling. Tutorials / long-form video aren't in scope; the
// place we're trying to extract is named in the first 30s of any normal Reel
// or TikTok. Defence-in-depth: byte cap also catches most "too long" cases.
export const MAX_VIDEO_DURATION_SEC = 90;

// Browser-like UA. TikTok refuses video bytes without a matching Referer;
// IG CDN doesn't strictly require it but is friendlier with both set.
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/17.0 Safari/605.1.15';

// Files API polling. The worker only waits up to MAX_POLLS * POLL_INTERVAL_MS
// for the file to become ACTIVE; if Gemini's pipeline is slow we bail out
// rather than burning the request budget.
const POLL_INTERVAL_MS = 1_000;
const MAX_POLLS = 8;

const GEMINI_BASE = 'https://generativelanguage.googleapis.com';

// Closed-vocab error classes. Mirrored by the strategy's isVideoFallbackError
// classifier on the app side; expanding this list requires updating both.
export type VideoErrorCode =
  | 'video-too-long'
  | 'video-too-large'
  | 'video-fetch-timeout'
  | 'video-fetch-network'
  | 'video-fetch-4xx'
  | 'video-fetch-5xx'
  | 'upload-start-failed'
  | 'upload-finalize-failed'
  | 'files-api-failed'
  | 'files-api-processing-timeout'
  | 'video-misconfigured';

export class VideoError extends Error {
  constructor(
    public readonly code: VideoErrorCode,
    public readonly status: number,
  ) {
    super(code);
    this.name = 'VideoError';
  }
}

export type VideoTransport = 'inline' | 'files_api';

export type VideoPart = Record<string, unknown>;

export type BuildVideoPartResult = {
  /** Gemini `parts` entry — either `inline_data` or `file_data`. */
  part: VideoPart;
  transport: VideoTransport;
  /** Bytes downloaded from the CDN. Useful for logs. */
  bytes: number;
  /**
   * Files API cleanup. For `files_api` transport this is a thunk the caller
   * MUST schedule (via `ctx.waitUntil`) AFTER the `generateContent` call —
   * including any in-call retry — has finished. For `inline` transport this
   * is `null` (nothing to clean up).
   *
   * Why the caller owns scheduling: a Files-API DELETE issued in parallel
   * with `generateContent` (e.g. inside `buildVideoPart` via waitUntil) races
   * the retry — when Gemini returns a transient 503 and the retry fires
   * 1 s later, the file is already gone and the retry hits 403
   * PERMISSION_DENIED. Returning the cleanup to the caller lets us delete
   * only after the consumer of `file_uri` is done with it.
   */
  cleanup: (() => Promise<void>) | null;
};

/**
 * Minimum-surface execution-context shape we need. Cloudflare's
 * `ExecutionContext` carries `waitUntil`; tests pass a stub.
 */
export type WaitUntilCtx = {
  waitUntil(promise: Promise<unknown>): void;
};

export type VideoEnv = {
  GEMINI_API_KEY: string;
};

export type BuildVideoPartInput = {
  url: string;
  durationSec?: number;
  /**
   * Optional Referer to use when fetching the video bytes from the CDN.
   * TikTok in particular has tightened auth-context enforcement on
   * `playAddr` URLs: a homepage Referer (https://www.tiktok.com/) is no
   * longer enough — the CDN wants the canonical video page URL
   * (https://www.tiktok.com/@user/video/123). The orchestrator passes
   * `fetched.permalink` here.
   */
  refererUrl?: string;
};

/**
 * Fetch a video URL and return the Gemini `parts` entry referencing it
 * (inline or via Files API). For Files-API uploads, the result carries a
 * `cleanup` thunk the caller MUST schedule (via `ctx.waitUntil`) AFTER
 * `generateContent` — and its in-call retry — has finished, so the DELETE
 * does not race the retry.
 */
export async function buildVideoPart(
  input: BuildVideoPartInput,
  env: VideoEnv,
  _ctx: WaitUntilCtx,
): Promise<BuildVideoPartResult> {
  // ctx is kept on the signature for API stability; cleanup scheduling now
  // belongs to the caller (see BuildVideoPartResult.cleanup).
  void _ctx;

  if (!env.GEMINI_API_KEY) {
    throw new VideoError('video-misconfigured', 500);
  }

  if (
    typeof input.durationSec === 'number' &&
    Number.isFinite(input.durationSec) &&
    input.durationSec > MAX_VIDEO_DURATION_SEC
  ) {
    throw new VideoError('video-too-long', 400);
  }

  const bytes = await fetchVideoBytes(input.url, input.refererUrl);

  if (bytes.length < INLINE_TRANSPORT_CUTOFF_BYTES) {
    return {
      part: { inline_data: { mime_type: 'video/mp4', data: bytesToBase64(bytes) } },
      transport: 'inline',
      bytes: bytes.length,
      cleanup: null,
    };
  }

  const file = await uploadViaFilesApi(bytes, env);
  return {
    part: { file_data: { mime_type: file.mimeType, file_uri: file.uri } },
    transport: 'files_api',
    bytes: bytes.length,
    cleanup: () => deleteFile(file.name, env),
  };
}

async function fetchVideoBytes(url: string, refererUrl?: string): Promise<Uint8Array> {
  const platform = detectPlatform(url);
  // Browser-realistic header set. TikTok's CDN (and increasingly IG's)
  // checks a combination of Referer, Origin, sec-fetch-*, and the
  // Range/Accept headers — a curl-shaped request gets a flat 403.
  const headers: Record<string, string> = {
    'User-Agent': BROWSER_UA,
    Accept: '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'identity', // no gzip — Workers fetch streams raw bytes
    Range: 'bytes=0-',
    'sec-fetch-dest': 'video',
    'sec-fetch-mode': 'no-cors',
    'sec-fetch-site': 'cross-site',
  };
  // Per-request Referer wins over the platform default. TikTok playAddr
  // URLs now require the canonical video-page URL as Referer; falling
  // back to the homepage Referer 403s.
  const referer =
    refererUrl ??
    (platform === 'instagram'
      ? 'https://www.instagram.com/'
      : platform === 'tiktok'
        ? 'https://www.tiktok.com/'
        : null);
  if (referer) headers['Referer'] = referer;
  // Origin pairs with Referer for cross-site fetches.
  if (platform === 'tiktok') headers['Origin'] = 'https://www.tiktok.com';
  else if (platform === 'instagram') headers['Origin'] = 'https://www.instagram.com';

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let resp: Response;
  try {
    resp = await fetch(url, { headers, signal: controller.signal });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw new VideoError('video-fetch-timeout', 504);
    throw new VideoError('video-fetch-network', 502);
  } finally {
    clearTimeout(t);
  }

  if (resp.status >= 400 && resp.status < 500) {
    // 206 Partial Content is OK when a Range header was honoured; only
    // 4xx terminal codes should fail. Log the actual status so a 403
    // (auth) is distinguishable from a 410 (gone / expired URL) etc.
    console.error(
      'extract-proxy/video: fetch-4xx',
      'status=' + resp.status,
      'platform=' + (platform ?? 'unknown'),
    );
    throw new VideoError('video-fetch-4xx', 502);
  }
  if (!resp.ok && resp.status !== 206) {
    console.error('extract-proxy/video: fetch-5xx', 'status=' + resp.status);
    throw new VideoError('video-fetch-5xx', 502);
  }

  if (!resp.body) {
    // No streaming body — fall through to .arrayBuffer with a size check.
    // This branch is unusual on Workers but defensible defensively.
    const ab = await resp.arrayBuffer();
    if (ab.byteLength > MAX_VIDEO_BYTES) throw new VideoError('video-too-large', 413);
    return new Uint8Array(ab);
  }

  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_VIDEO_BYTES) {
        // Never pass truncated bytes to Gemini — abort cleanly.
        await reader.cancel().catch(() => {});
        throw new VideoError('video-too-large', 413);
      }
      chunks.push(value);
    }
  } catch (err) {
    if (err instanceof VideoError) throw err;
    throw new VideoError('video-fetch-network', 502);
  }

  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

function detectPlatform(url: string): 'instagram' | 'tiktok' | null {
  // Match cdninstagram.com, fbcdn.net, tiktokcdn.com and the like by simple
  // hostname substring — these CDNs use many subdomain shards.
  const lower = url.toLowerCase();
  if (lower.includes('cdninstagram.com') || lower.includes('fbcdn.net')) return 'instagram';
  if (lower.includes('tiktok.com') || lower.includes('tiktokcdn')) return 'tiktok';
  return null;
}

type UploadedFile = { name: string; uri: string; mimeType: string };

async function uploadViaFilesApi(bytes: Uint8Array, env: VideoEnv): Promise<UploadedFile> {
  const start = await startResumableUpload(bytes.byteLength, env);
  const uploaded = await finalizeResumableUpload(start.uploadUrl, bytes);

  // The finalize response may already give state=ACTIVE on small clips;
  // poll only if it's still PROCESSING.
  let file = uploaded;
  for (let i = 0; file.state === 'PROCESSING' && i < MAX_POLLS; i++) {
    await sleep(POLL_INTERVAL_MS);
    file = await pollFile(file.name, env);
  }
  if (file.state === 'FAILED') throw new VideoError('files-api-failed', 502);
  if (file.state !== 'ACTIVE') throw new VideoError('files-api-processing-timeout', 504);

  return { name: file.name, uri: file.uri, mimeType: file.mimeType };
}

type FileResource = {
  name: string;
  uri: string;
  mimeType: string;
  state: 'ACTIVE' | 'PROCESSING' | 'FAILED' | string;
};

async function startResumableUpload(
  byteLength: number,
  env: VideoEnv,
): Promise<{ uploadUrl: string }> {
  const url = `${GEMINI_BASE}/upload/v1beta/files?key=${encodeURIComponent(env.GEMINI_API_KEY)}`;
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: {
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': String(byteLength),
        'X-Goog-Upload-Header-Content-Type': 'video/mp4',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ file: { display_name: 'reel.mp4' } }),
    });
  } catch {
    throw new VideoError('upload-start-failed', 502);
  }
  if (!resp.ok) {
    console.error('extract-proxy/video: upload-start non-2xx', resp.status);
    throw new VideoError('upload-start-failed', 502);
  }
  const uploadUrl = resp.headers.get('x-goog-upload-url');
  if (!uploadUrl) {
    console.error('extract-proxy/video: upload-start no upload-url header');
    throw new VideoError('upload-start-failed', 502);
  }
  return { uploadUrl };
}

async function finalizeResumableUpload(
  uploadUrl: string,
  bytes: Uint8Array,
): Promise<FileResource> {
  let resp: Response;
  try {
    resp = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        'Content-Length': String(bytes.byteLength),
        'X-Goog-Upload-Offset': '0',
        'X-Goog-Upload-Command': 'upload, finalize',
      },
      body: bytes,
    });
  } catch {
    throw new VideoError('upload-finalize-failed', 502);
  }
  if (!resp.ok) {
    console.error('extract-proxy/video: upload-finalize non-2xx', resp.status);
    throw new VideoError('upload-finalize-failed', 502);
  }
  let body: unknown;
  try {
    body = await resp.json();
  } catch {
    throw new VideoError('upload-finalize-failed', 502);
  }
  return readFileResource(body);
}

async function pollFile(name: string, env: VideoEnv): Promise<FileResource> {
  const url = `${GEMINI_BASE}/v1beta/${encodeURI(name)}?key=${encodeURIComponent(
    env.GEMINI_API_KEY,
  )}`;
  let resp: Response;
  try {
    resp = await fetch(url);
  } catch {
    throw new VideoError('files-api-failed', 502);
  }
  if (!resp.ok) throw new VideoError('files-api-failed', 502);
  let body: unknown;
  try {
    body = await resp.json();
  } catch {
    throw new VideoError('files-api-failed', 502);
  }
  return readFileResource(body);
}

async function deleteFile(name: string, env: VideoEnv): Promise<void> {
  const url = `${GEMINI_BASE}/v1beta/${encodeURI(name)}?key=${encodeURIComponent(
    env.GEMINI_API_KEY,
  )}`;
  try {
    const resp = await fetch(url, { method: 'DELETE' });
    if (!resp.ok) console.warn('extract-proxy/video: delete-failed', resp.status);
  } catch (err) {
    console.warn('extract-proxy/video: delete-failed', String(err));
  }
}

function readFileResource(body: unknown): FileResource {
  // Files API can return either `{ file: {...} }` or `{ ...file fields }`
  // depending on the endpoint. Both shapes get normalised here.
  const root =
    typeof body === 'object' && body !== null && 'file' in body
      ? (body as { file: unknown }).file
      : body;
  if (typeof root !== 'object' || root === null) {
    throw new VideoError('files-api-failed', 502);
  }
  const r = root as Record<string, unknown>;
  const name = typeof r.name === 'string' ? r.name : '';
  const uri = typeof r.uri === 'string' ? r.uri : '';
  const mimeType = typeof r.mimeType === 'string' ? r.mimeType : 'video/mp4';
  const state = typeof r.state === 'string' ? r.state : 'PROCESSING';
  if (!name || !uri) throw new VideoError('files-api-failed', 502);
  return { name, uri, mimeType, state };
}

export function bytesToBase64(bytes: Uint8Array): string {
  // Chunked base64 to avoid blowing the call stack on `String.fromCharCode`
  // with multi-megabyte arrays.
  const CHUNK = 0x8000;
  let bin = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, Math.min(i + CHUNK, bytes.length));
    bin += String.fromCharCode(...slice);
  }
  return btoa(bin);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
