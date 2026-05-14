import {
  extractionResponseSchema,
  requestBodySchema,
  type ExtractionResponse,
} from './schema';
import { GEMINI_MODEL, GEMINI_RESPONSE_SCHEMA, SYSTEM_PROMPT } from './prompt';
import { handleEnrich } from './enrich';
import { handleFetchPost } from './fetch-post';
import { handlePhoto } from './photo';
import { requireEntitlement } from './entitlement';

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
}

const JSON_HEADERS = { 'content-type': 'application/json' } as const;

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { ...JSON_HEADERS, ...(init.headers ?? {}) },
  });
}

function errorResponse(error: string, status: number, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders },
  });
}

export async function handleExtract(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') {
    return errorResponse('method-not-allowed', 405);
  }

  const gate = await requireEntitlement(request, env);
  if (!gate.ok) return gate.response;

  // Misconfiguration is the operator's problem, not the client's. 500 so
  // the client treats it as retryable; the operator sees the error class
  // in Workers Logs.
  if (!env.GEMINI_API_KEY) {
    console.error('extract-proxy: GEMINI_API_KEY missing');
    return errorResponse('server-misconfigured', 500);
  }
  if (!env.CF_ACCOUNT_ID) {
    console.error('extract-proxy: CF_ACCOUNT_ID missing');
    return errorResponse('server-misconfigured', 500);
  }
  if (!env.AI_GATEWAY_NAME) {
    console.error('extract-proxy: AI_GATEWAY_NAME missing');
    return errorResponse('server-misconfigured', 500);
  }
  if (!env.CF_AIG_TOKEN) {
    console.error('extract-proxy: CF_AIG_TOKEN missing');
    return errorResponse('server-misconfigured', 500);
  }

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

  const parsed = requestBodySchema.safeParse(raw);
  if (!parsed.success) {
    return errorResponse('invalid-request-body', 400);
  }

  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  const { success: rateOk } = await env.RATE_LIMIT.limit({ key: ip });
  if (!rateOk) {
    return errorResponse('rate-limited', 429, { 'retry-after': '60' });
  }

  // Truncation defense: a pathological screenshot shouldn't blow the input
  // budget. Realistic OCR is well below this; the cap exists so anything
  // past it gets clipped, not rejected.
  const ocrText = parsed.data.ocr_text.slice(0, 10000);

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
        contents: [{ role: 'user', parts: [{ text: ocrText }] }],
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: GEMINI_RESPONSE_SCHEMA,
        },
      }),
    });
  } catch (err) {
    console.error('extract-proxy: gemini-network-error', String(err));
    return errorResponse('upstream-network-error', 502);
  }

  if (geminiResp.status === 429) {
    const retryAfter = geminiResp.headers.get('retry-after') ?? '60';
    return errorResponse('upstream-rate-limited', 429, { 'retry-after': retryAfter });
  }

  if (!geminiResp.ok) {
    console.error('extract-proxy: gemini-upstream-error', geminiResp.status);
    return errorResponse('upstream-error', 502);
  }

  let geminiBody: unknown;
  try {
    geminiBody = await geminiResp.json();
  } catch {
    console.error('extract-proxy: gemini-non-json-body');
    return errorResponse('upstream-non-json', 502);
  }

  const candidateText = extractCandidateText(geminiBody);
  if (candidateText === null) {
    console.error('extract-proxy: gemini-shape-unexpected');
    return errorResponse('upstream-bad-shape', 502);
  }

  let inner: unknown;
  try {
    inner = JSON.parse(candidateText);
  } catch {
    console.error('extract-proxy: gemini-inner-parse-failed');
    return errorResponse('upstream-malformed-inner-json', 502);
  }

  const validated = extractionResponseSchema.safeParse(inner);
  if (!validated.success) {
    console.error('extract-proxy: gemini-schema-violation');
    return errorResponse('upstream-schema-violation', 502);
  }

  const response: ExtractionResponse & { model: string } = {
    places: validated.data.places,
    model: GEMINI_MODEL,
  };
  return jsonResponse(response, { status: 200 });
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
  fetch(request: Request, env: Env): Promise<Response> {
    return route(request, env);
  },
};

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path === '/extract') return handleExtract(request, env);
  if (path === '/enrich') return handleEnrich(request, env);
  if (path === '/fetch-post') return handleFetchPost(request, env);
  if (path.startsWith('/photo/')) return handlePhoto(request, env);
  return errorResponse('not-found', 404);
}
