import {
  extractionResponseSchema,
  type ExtractionResponse,
  type RequestBody,
} from './schema';
import { GEMINI_MODEL, GEMINI_RESPONSE_SCHEMA, SYSTEM_PROMPT, VIDEO_PROMPT_SUFFIX } from './prompt';
import { handleEnrich } from './enrich';
import { handlePhoto } from './photo';
import { requireEntitlement } from './entitlement';
import { buildVideoPart, VideoError, type WaitUntilCtx } from './video';
import { orchestratorRequestSchema } from './orchestrator-schema';
import { orchestrate, readState } from './orchestrator';

export interface RateLimitBinding {
  limit(args: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  GEMINI_API_KEY: string;
  GOOGLE_PLACES_API_KEY: string;
  CF_ACCOUNT_ID: string;
  AI_GATEWAY_NAME: string;
  CF_AIG_TOKEN: string;
  RATE_LIMIT: RateLimitBinding;
  // Apify: actor id is a plain var (defaulted in wrangler.toml), token is a
  // secret. Both are read by /fetch-post for the IG carousel / og-failure path.
  APIFY_TOKEN?: string;
  APIFY_ACTOR_ID?: string;
  RC_REST_API_KEY: string;
  EXTRACT_STATE: KVNamespace;
}

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
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders },
  });
}

// Default ctx for unit tests that don't care about Files API cleanup
// (text/vision modes never schedule waitUntil work).
const NOOP_CTX: WaitUntilCtx = { waitUntil: () => {} };

export class RunExtractError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    public readonly retryAfter?: string,
  ) {
    super(code);
    this.name = 'RunExtractError';
  }
}

// Pure (no Request, no Response) wrapper around the Gemini call. Same env
// requirements as handleExtract. Throws RunExtractError on misconfig or
// upstream failure; otherwise returns the parsed places + model. The
// orchestrator (src/orchestrator.ts) calls this directly without going
// through HTTP.
export async function runExtract(
  body: RequestBody,
  env: Env,
  ctx: WaitUntilCtx = NOOP_CTX,
): Promise<ExtractionResponse & { model: string }> {
  // Misconfiguration is the operator's problem, not the client's. 500 so
  // the client treats it as retryable; the operator sees the error class
  // in Workers Logs.
  if (!env.GEMINI_API_KEY) {
    console.error('extract-proxy: GEMINI_API_KEY missing');
    throw new RunExtractError('server-misconfigured', 500);
  }
  if (!env.CF_ACCOUNT_ID) {
    console.error('extract-proxy: CF_ACCOUNT_ID missing');
    throw new RunExtractError('server-misconfigured', 500);
  }
  if (!env.AI_GATEWAY_NAME) {
    console.error('extract-proxy: AI_GATEWAY_NAME missing');
    throw new RunExtractError('server-misconfigured', 500);
  }
  if (!env.CF_AIG_TOKEN) {
    console.error('extract-proxy: CF_AIG_TOKEN missing');
    throw new RunExtractError('server-misconfigured', 500);
  }

  // Build the Gemini `parts` array based on the request mode. Text mode
  // sends a single text part. Vision mode sends an inline_data image part,
  // optionally followed by a caption text part. Video mode fetches the URL
  // from the worker (closer to IG/TikTok CDN than the phone) and either
  // inlines the bytes or uploads via Gemini's Files API. Truncation
  // defense applies to text inputs only — a pathological caption shouldn't
  // blow the budget.
  let parts: Array<Record<string, unknown>>;
  let systemPrompt = SYSTEM_PROMPT;
  if (body.mode === 'video') {
    try {
      const { part } = await buildVideoPart(
        {
          url: body.video.url,
          durationSec: body.video.durationSec,
          refererUrl: body.video.refererUrl,
        },
        env,
        ctx,
      );
      parts = [part];
      if (body.caption && body.caption.trim().length > 0) {
        parts.push({
          text: `User-supplied caption:\n${body.caption.slice(0, TEXT_INPUT_CAP)}`,
        });
      }
      systemPrompt = SYSTEM_PROMPT + VIDEO_PROMPT_SUFFIX;
    } catch (err) {
      if (err instanceof VideoError) {
        console.error('extract-proxy/video: ' + err.code);
        throw new RunExtractError(err.code, err.status);
      }
      throw err;
    }
  } else {
    parts = buildGeminiParts(body);
  }

  // Route through Cloudflare AI Gateway so we get caching, analytics, and
  // a single chokepoint for upstream provider swaps. The `?key=` is forwarded
  // to Google AI Studio; `cf-aig-authorization` authenticates us to the
  // gateway itself (Authenticated Gateways feature).
  const gatewayUrl =
    `https://gateway.ai.cloudflare.com/v1/${env.CF_ACCOUNT_ID}/${env.AI_GATEWAY_NAME}` +
    `/google-ai-studio/v1beta/models/${GEMINI_MODEL}:generateContent?key=${env.GEMINI_API_KEY}`;

  let geminiResp: Response;
  try {
    geminiResp = await fetch(gatewayUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'cf-aig-authorization': `Bearer ${env.CF_AIG_TOKEN}`,
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts }],
        systemInstruction: { parts: [{ text: systemPrompt }] },
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: GEMINI_RESPONSE_SCHEMA,
        },
      }),
    });
  } catch (err) {
    console.error('extract-proxy: gemini-network-error', String(err));
    throw new RunExtractError('upstream-network-error', 502);
  }

  if (geminiResp.status === 429) {
    const retryAfter = geminiResp.headers.get('retry-after') ?? '60';
    throw new RunExtractError('upstream-rate-limited', 429, retryAfter);
  }
  if (!geminiResp.ok) {
    console.error('extract-proxy: gemini-upstream-error', geminiResp.status);
    throw new RunExtractError('upstream-error', 502);
  }

  let geminiBody: unknown;
  try {
    geminiBody = await geminiResp.json();
  } catch {
    console.error('extract-proxy: gemini-non-json-body');
    throw new RunExtractError('upstream-non-json', 502);
  }

  const candidateText = extractCandidateText(geminiBody);
  if (candidateText === null) {
    console.error('extract-proxy: gemini-shape-unexpected');
    throw new RunExtractError('upstream-bad-shape', 502);
  }

  let inner: unknown;
  try {
    inner = JSON.parse(candidateText);
  } catch {
    console.error('extract-proxy: gemini-inner-parse-failed');
    throw new RunExtractError('upstream-malformed-inner-json', 502);
  }

  const validated = extractionResponseSchema.safeParse(inner);
  if (!validated.success) {
    console.error('extract-proxy: gemini-schema-violation');
    throw new RunExtractError('upstream-schema-violation', 502);
  }

  return { places: validated.data.places, model: GEMINI_MODEL };
}

/**
 * POST /extract — share-time pre-warm. Idempotent, async.
 *
 *   { contentHash, kind: 'url', url, suggestedTripId? } →
 *     200 with cached state on hit; 202 {status:'pending'} on miss
 *
 * Cache miss schedules orchestrate() via ctx.waitUntil so the pipeline
 * runs after the response. Workers Paid plan affords ~5 min wall-clock —
 * enough for Apify + Gemini video extraction.
 */
export async function handleExtractPost(
  request: Request,
  env: Env,
  ctx: WaitUntilCtx,
): Promise<Response> {
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
  const parsed = orchestratorRequestSchema.safeParse(raw);
  if (!parsed.success) return errorResponse('invalid-request-body', 400);

  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  const { success: rateOk } = await env.RATE_LIMIT.limit({ key: ip });
  if (!rateOk) return errorResponse('rate-limited', 429, { 'retry-after': '60' });

  const cached = await readState(parsed.data.contentHash, env);
  if (cached) {
    return jsonResponse(cached, { status: 200 });
  }

  // Schedule the pipeline after the response. The async work survives
  // until ctx.waitUntil's budget runs out.
  ctx.waitUntil(orchestrate(parsed.data, env, ctx));

  return jsonResponse(
    {
      contentHash: parsed.data.contentHash,
      status: 'pending',
      startedAt: new Date().toISOString(),
    },
    { status: 202 },
  );
}

/**
 * GET /extract/:contentHash — poll the cached state. Returns 404 with
 * status='missing' when the orchestrator hasn't been triggered for this
 * hash (or the TTL expired).
 */
export async function handleExtractGet(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'GET') return errorResponse('method-not-allowed', 405);

  const gate = await requireEntitlement(request, env);
  if (!gate.ok) return gate.response;

  const url = new URL(request.url);
  const m = url.pathname.match(/^\/extract\/([0-9a-f]{64})$/);
  if (!m) return errorResponse('invalid-content-hash', 400);
  const hash = m[1]!;

  const state = await readState(hash, env);
  if (!state) {
    return jsonResponse({ contentHash: hash, status: 'missing' }, { status: 404 });
  }
  return jsonResponse(state, { status: 200 });
}

// Maximum text-input length (chars). Realistic OCR / captions are well below
// this; the cap exists so a pathological input gets clipped, not rejected.
const TEXT_INPUT_CAP = 10000;

// Default mime type when sniffing fails. PNG-with-alpha would also be valid
// — Gemini accepts both; the app's downscale step emits JPEG so this is the
// expected common case.
const DEFAULT_IMAGE_MIME = 'image/jpeg';

function buildGeminiParts(body: RequestBody): Array<Record<string, unknown>> {
  if (body.mode === 'text') {
    return [{ text: body.text.slice(0, TEXT_INPUT_CAP) }];
  }
  if (body.mode === 'vision') {
    const mimeType = sniffImageMime(body.imageBase64) ?? DEFAULT_IMAGE_MIME;
    const parts: Array<Record<string, unknown>> = [
      { inline_data: { mime_type: mimeType, data: body.imageBase64 } },
    ];
    if (body.caption && body.caption.trim().length > 0) {
      parts.push({ text: `User-supplied caption:\n${body.caption.slice(0, TEXT_INPUT_CAP)}` });
    }
    return parts;
  }
  // 'video' is handled separately in handleExtract — buildVideoPart needs
  // async fetch + ctx.waitUntil, which doesn't fit a sync helper.
  throw new Error('buildGeminiParts: video mode must be handled in handleExtract');
}

// Sniff the first base64-decoded bytes to detect the image format. Cheap
// — only decodes the first ~12 bytes. Returns null when unrecognised, in
// which case the caller falls back to the default mime.
function sniffImageMime(b64: string): string | null {
  // Decode just enough leading bytes for the magic-number check.
  const head = b64.slice(0, 16);
  let bytes: string;
  try {
    bytes = atob(head);
  } catch {
    return null;
  }
  if (bytes.startsWith('\xff\xd8\xff')) return 'image/jpeg';
  if (bytes.startsWith('\x89PNG\r\n\x1a\n')) return 'image/png';
  if (bytes.startsWith('GIF87a') || bytes.startsWith('GIF89a')) return 'image/gif';
  // WebP: "RIFF????WEBP" — first 4 bytes RIFF, then 4 size bytes we skip,
  // then "WEBP". The 16-char b64 prefix only decodes to ~12 bytes, so we
  // can check the RIFF prefix and trust it for now.
  if (bytes.startsWith('RIFF')) return 'image/webp';
  return null;
}

function extractCandidateText(geminiBody: unknown): string | null {
  if (typeof geminiBody !== 'object' || geminiBody === null) return null;
  const candidates = (geminiBody as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  const first = candidates[0];
  if (typeof first !== 'object' || first === null) return null;
  const content = (first as { content?: unknown }).content;
  if (typeof content !== 'object' || content === null) return null;
  const parts = (content as { parts?: unknown }).parts;
  if (!Array.isArray(parts) || parts.length === 0) return null;
  const text = (parts[0] as { text?: unknown }).text;
  return typeof text === 'string' ? text : null;
}

export default {
  fetch(request: Request, env: Env, ctx: WaitUntilCtx): Promise<Response> {
    return route(request, env, ctx);
  },
};

async function route(request: Request, env: Env, ctx: WaitUntilCtx): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  // Share-time pre-warm orchestrator. Replaces the legacy POST /extract
  // (text/vision/video body shape) and the standalone POST /fetch-post —
  // both are now internal helpers (runExtract, runFetchPost) the
  // orchestrator drives directly.
  if (path === '/extract' && request.method === 'POST') return handleExtractPost(request, env, ctx);
  if (path.startsWith('/extract/') && request.method === 'GET') return handleExtractGet(request, env);
  if (path === '/enrich') return handleEnrich(request, env);
  if (path.startsWith('/photo/')) return handlePhoto(request, env);
  return errorResponse('not-found', 404);
}
