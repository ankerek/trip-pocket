import { z } from 'zod';
import type { Env } from './index';
import { GEMINI_MODEL } from './prompt';
import { requireEntitlement } from './entitlement';

// Request body. The OCR caption is required: the worker is stateless, so
// the Gemini blurb step can only ground the narrative in OCR text that
// the client passed in.
export const enrichRequestSchema = z.object({
  extracted_place_id: z.string().min(1),
  name: z.string().min(1),
  city: z.string(),
  address: z.string().nullable().optional(),
  ocr_caption: z
    .string()
    .min(1)
    .transform((s) => s.slice(0, 4000)),
});

export type EnrichRequest = z.infer<typeof enrichRequestSchema>;

// Closed-vocab debug echo describing the worker's per-step outcomes for
// /enrich (Google Places searchText + details + Gemini blurb). The phone
// forwards these into the `enrichment` stage's firehose extras so the
// pipeline log shows which sub-step degraded without a `wrangler tail`
// round-trip. See docs/superpowers/specs/2026-05-13-pipeline-observability-design.md
// §Worker debug echo (mirrors the /fetch-post pattern).
export const enrichDebugSchema = z.object({
  searchOutcome: z.enum([
    'ok',
    'empty',
    'rate_limited',
    'upstream_4xx',
    'upstream_5xx',
    'network',
    'non_json',
  ]),
  detailsOutcome: z.enum([
    'not_called',
    'ok',
    'missing_id',
    'rate_limited',
    'upstream_4xx',
    'upstream_5xx',
    'network',
    'non_json',
  ]),
  blurbOutcome: z.enum(['not_called', 'ok', 'empty', 'failed']),
});

export type EnrichDebug = z.infer<typeof enrichDebugSchema>;

// Successful response schema (defense-in-depth — the client also validates).
export const enrichResponseSchema = z.union([
  z.object({
    status: z.literal('enriched'),
    external_place_id: z.string().min(1),
    latitude: z.number().nullable(),
    longitude: z.number().nullable(),
    formatted_address: z.string().nullable(),
    photo_name: z.string().nullable(),
    description: z.string().nullable(),
    rating: z.number().nullable(),
    price_level: z.number().int().nullable(),
    external_url: z.string().nullable(),
    // Both come from Google Places addressComponents. NULL when Google
    // didn't return the corresponding entry. country_code is uppercase
    // ISO-2; the worker normalises before serialising.
    city: z.string().nullable(),
    country_code: z.string().nullable(),
    model: z.string(),
    _debug: enrichDebugSchema.optional(),
  }),
  z.object({
    status: z.literal('not-found'),
    _debug: enrichDebugSchema.optional(),
  }),
]);

export type EnrichResponse = z.infer<typeof enrichResponseSchema>;

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
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { ...JSON_HEADERS, ...extra },
  });
}

export async function handleEnrich(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return errorResponse('method-not-allowed', 405);

  const gate = await requireEntitlement(request, env);
  if (!gate.ok) return gate.response;

  if (!env.GOOGLE_PLACES_API_KEY) {
    console.error('extract-proxy/enrich: GOOGLE_PLACES_API_KEY missing');
    return errorResponse('server-misconfigured', 500);
  }
  if (!env.GEMINI_API_KEY) {
    console.error('extract-proxy/enrich: GEMINI_API_KEY missing');
    return errorResponse('server-misconfigured', 500);
  }
  if (!env.CF_ACCOUNT_ID || !env.AI_GATEWAY_NAME || !env.CF_AIG_TOKEN) {
    console.error('extract-proxy/enrich: AI Gateway config missing');
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
  const parsed = enrichRequestSchema.safeParse(raw);
  if (!parsed.success) return errorResponse('invalid-request-body', 400);

  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  const { success: rateOk } = await env.RATE_LIMIT.limit({ key: ip });
  if (!rateOk) return errorResponse('rate-limited', 429, { 'retry-after': '60' });

  // 1. Find Place from Text — Places API (New) `places:searchText`.
  let foundPlaceId: string;
  try {
    const result = await searchText(parsed.data, env);
    if (result === null) {
      return jsonResponse({
        status: 'not-found' satisfies EnrichResponse['status'],
        _debug: {
          searchOutcome: 'empty',
          detailsOutcome: 'not_called',
          blurbOutcome: 'not_called',
        },
      });
    }
    foundPlaceId = result;
  } catch (err) {
    return placesErrorToResponse('searchText', err);
  }

  // 2. Place Details — Places API (New) GET /v1/places/{place_id}.
  let details: PlaceDetails;
  try {
    details = await getPlaceDetails(foundPlaceId, env);
  } catch (err) {
    return placesErrorToResponse('details', err);
  }

  // 3. Gemini blurb — best-effort. If it fails, return the Places data
  // with description=null. The user gets the photo + rating without a
  // narrative; the next /enrich on the same row will retry the blurb.
  const blurb = await safeBuildBlurb(parsed.data, details, env);

  const response: EnrichResponse = {
    status: 'enriched',
    external_place_id: details.id,
    latitude: details.latitude,
    longitude: details.longitude,
    formatted_address: details.formattedAddress,
    photo_name: details.photoName,
    description: blurb.text,
    rating: details.rating,
    price_level: details.priceLevel,
    external_url: details.googleMapsUri,
    city: details.city,
    country_code: details.countryCode,
    model: GEMINI_MODEL,
    _debug: {
      searchOutcome: 'ok',
      detailsOutcome: 'ok',
      blurbOutcome: blurb.outcome,
    },
  };
  return jsonResponse(response);
}

// --- Google Places client ---

class PlacesError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'PlacesError';
  }
}

async function searchText(req: EnrichRequest, env: Env): Promise<string | null> {
  const locationHint = req.address?.trim() || req.city || '';
  const textQuery = [req.name, locationHint].filter(Boolean).join(', ');

  const resp = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Goog-Api-Key': env.GOOGLE_PLACES_API_KEY,
      'X-Goog-FieldMask': 'places.id',
    },
    body: JSON.stringify({ textQuery, maxResultCount: 1 }),
  });

  if (!resp.ok) {
    throw new PlacesError(resp.status, `searchText ${resp.status}`);
  }

  let body: unknown;
  try {
    body = await resp.json();
  } catch {
    throw new PlacesError(502, 'searchText non-json');
  }
  const places = (body as { places?: Array<{ id?: string }> }).places;
  if (!Array.isArray(places) || places.length === 0) return null;
  const id = places[0]?.id;
  if (typeof id !== 'string' || id.length === 0) return null;
  return id;
}

type PlaceDetails = {
  id: string;
  latitude: number | null;
  longitude: number | null;
  formattedAddress: string | null;
  photoName: string | null;
  rating: number | null;
  priceLevel: number | null;
  googleMapsUri: string | null;
  displayName: string | null;
  types: string[];
  editorialSummary: string | null;
  city: string | null; // addressComponents[type=locality].longText
  countryCode: string | null; // addressComponents[type=country].shortText, uppercased
};

async function getPlaceDetails(placeId: string, env: Env): Promise<PlaceDetails> {
  const fields = [
    'id',
    'displayName',
    'location',
    'formattedAddress',
    'photos',
    'rating',
    'priceLevel',
    'types',
    'googleMapsUri',
    'websiteUri',
    'editorialSummary',
    'addressComponents',
  ].join(',');

  const resp = await fetch(
    `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`,
    {
      method: 'GET',
      headers: {
        'X-Goog-Api-Key': env.GOOGLE_PLACES_API_KEY,
        'X-Goog-FieldMask': fields,
      },
    },
  );

  if (!resp.ok) {
    throw new PlacesError(resp.status, `placeDetails ${resp.status}`);
  }

  let body: unknown;
  try {
    body = await resp.json();
  } catch {
    throw new PlacesError(502, 'placeDetails non-json');
  }
  const obj = body as {
    id?: string;
    displayName?: { text?: string };
    location?: { latitude?: number; longitude?: number };
    formattedAddress?: string;
    photos?: Array<{ name?: string }>;
    rating?: number;
    priceLevel?: string;
    types?: string[];
    googleMapsUri?: string;
    editorialSummary?: { text?: string };
    addressComponents?: Array<{ types?: string[]; longText?: string; shortText?: string }>;
  };
  if (typeof obj.id !== 'string') {
    throw new PlacesError(502, 'placeDetails missing id');
  }

  const components = Array.isArray(obj.addressComponents) ? obj.addressComponents : [];
  const locality = components.find((c) => c.types?.includes('locality'));
  const country = components.find((c) => c.types?.includes('country'));

  return {
    id: obj.id,
    latitude: typeof obj.location?.latitude === 'number' ? obj.location.latitude : null,
    longitude: typeof obj.location?.longitude === 'number' ? obj.location.longitude : null,
    formattedAddress: typeof obj.formattedAddress === 'string' ? obj.formattedAddress : null,
    photoName:
      Array.isArray(obj.photos) && typeof obj.photos[0]?.name === 'string'
        ? obj.photos[0].name
        : null,
    rating: typeof obj.rating === 'number' ? obj.rating : null,
    priceLevel: priceLevelToInt(obj.priceLevel),
    googleMapsUri: typeof obj.googleMapsUri === 'string' ? obj.googleMapsUri : null,
    displayName: typeof obj.displayName?.text === 'string' ? obj.displayName.text : null,
    types: Array.isArray(obj.types)
      ? obj.types.filter((t): t is string => typeof t === 'string')
      : [],
    editorialSummary:
      typeof obj.editorialSummary?.text === 'string' ? obj.editorialSummary.text : null,
    city:
      typeof locality?.longText === 'string' && locality.longText.length > 0
        ? locality.longText
        : null,
    countryCode:
      typeof country?.shortText === 'string' && country.shortText.length > 0
        ? country.shortText.toUpperCase()
        : null,
  };
}

function priceLevelToInt(value: unknown): number | null {
  // Places API (New) returns enum strings: PRICE_LEVEL_FREE, _INEXPENSIVE,
  // _MODERATE, _EXPENSIVE, _VERY_EXPENSIVE. Map to 0-4 for storage.
  switch (value) {
    case 'PRICE_LEVEL_FREE':
      return 0;
    case 'PRICE_LEVEL_INEXPENSIVE':
      return 1;
    case 'PRICE_LEVEL_MODERATE':
      return 2;
    case 'PRICE_LEVEL_EXPENSIVE':
      return 3;
    case 'PRICE_LEVEL_VERY_EXPENSIVE':
      return 4;
    default:
      return null;
  }
}

function placesErrorToResponse(stage: string, err: unknown): Response {
  if (err instanceof PlacesError) {
    if (err.status === 429) {
      return errorResponse('upstream-rate-limited', 429, { 'retry-after': '60' });
    }
    if (err.status >= 500) {
      console.error(`extract-proxy/enrich: places-${stage}-5xx`, err.status);
      return errorResponse('upstream-error', 502);
    }
    if (err.status >= 400) {
      console.error(`extract-proxy/enrich: places-${stage}-4xx`, err.status);
      return errorResponse('upstream-bad-request', 502);
    }
  }
  console.error(`extract-proxy/enrich: places-${stage}-network`, String(err));
  return errorResponse('upstream-network-error', 502);
}

// --- Gemini blurb (best-effort) ---

const BLURB_SYSTEM_PROMPT = `You write a 1–2 sentence travel blurb for a place card. The user already knows the venue's name and city — your job is to add the texture and atmosphere they would lose by closing the screenshot. Plain prose, no marketing voice, no hashtags, no emoji. Cap output at 240 characters.

Use the structured Google Places facts AND the user's OCR caption from the screenshot. Prefer concrete details (cuisine, vibe, neighborhood character, what it's known for) over generic descriptors. If the OCR caption mentions a specific dish, view, or moment that's specific to the place, name it. If the inputs are too thin to write something specific, write a single short factual sentence rather than padding with filler.

Output only the blurb text. No leading label, no quotes, no formatting.`;

type BlurbOutcome = Extract<EnrichDebug['blurbOutcome'], 'ok' | 'empty' | 'failed'>;

// Class of blurb failure. Used by the in-call retry to decide whether to
// take a second attempt: transient = yes (network blip, Gemini 5xx);
// permanent = no (4xx is a bad request, retrying won't change it);
// rate-limited = no (a 500ms in-call backoff would just hit the limit
// again — the upstream is asking for a longer wait).
type BlurbFailureClass = 'transient' | 'permanent' | 'rate_limited';

class BlurbError extends Error {
  constructor(
    public readonly failureClass: BlurbFailureClass,
    message: string,
  ) {
    super(message);
    this.name = 'BlurbError';
  }
}

const BLURB_RETRY_DELAY_MS = 500;
const BLURB_MAX_ATTEMPTS = 2;

async function safeBuildBlurb(
  req: EnrichRequest,
  details: PlaceDetails,
  env: Env,
): Promise<{ text: string | null; outcome: BlurbOutcome }> {
  // One transient retry. Capped at 2 attempts so a hard Gemini outage
  // doesn't add a full second of latency to every /enrich. Permanent and
  // rate-limited failures skip the retry — see BlurbFailureClass above.
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= BLURB_MAX_ATTEMPTS; attempt++) {
    try {
      const text = await buildBlurb(req, details, env);
      if (text === null || text.length === 0) {
        // Gemini returned 200 but no usable text (whitespace-only candidate,
        // missing parts, etc). Same effect as a failure from the caller's
        // perspective — description is null — but a distinct firehose signal
        // so we can tell "model declined" from "model errored" when triaging.
        return { text: null, outcome: 'empty' };
      }
      return { text, outcome: 'ok' };
    } catch (err) {
      lastErr = err;
      const cls = err instanceof BlurbError ? err.failureClass : 'transient';
      if (cls !== 'transient' || attempt === BLURB_MAX_ATTEMPTS) break;
      await new Promise((r) => setTimeout(r, BLURB_RETRY_DELAY_MS));
    }
  }
  console.error('extract-proxy/enrich: blurb-failed', String(lastErr));
  return { text: null, outcome: 'failed' };
}

async function buildBlurb(
  req: EnrichRequest,
  details: PlaceDetails,
  env: Env,
): Promise<string | null> {
  const factsForPrompt = {
    name: details.displayName ?? req.name,
    city: req.city,
    formatted_address: details.formattedAddress,
    rating: details.rating,
    price_level: details.priceLevel,
    types: details.types,
    editorial_summary: details.editorialSummary,
  };

  const userText = [
    'Place facts (Google Places):',
    JSON.stringify(factsForPrompt, null, 2),
    '',
    "User's OCR caption from the screenshot:",
    req.ocr_caption,
  ].join('\n');

  const gatewayUrl =
    `https://gateway.ai.cloudflare.com/v1/${env.CF_ACCOUNT_ID}/${env.AI_GATEWAY_NAME}` +
    `/google-ai-studio/v1beta/models/${GEMINI_MODEL}:generateContent?key=${env.GEMINI_API_KEY}`;

  let resp: Response;
  try {
    resp = await fetch(gatewayUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'cf-aig-authorization': `Bearer ${env.CF_AIG_TOKEN}`,
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: userText }] }],
        systemInstruction: { parts: [{ text: BLURB_SYSTEM_PROMPT }] },
        generationConfig: {
          responseMimeType: 'text/plain',
          maxOutputTokens: 200,
          temperature: 0.4,
        },
      }),
    });
  } catch (err) {
    // Network failure (DNS, TLS, connection reset, etc) — try again.
    throw new BlurbError('transient', `gemini-network: ${String(err)}`);
  }

  if (!resp.ok) {
    // 4xx is permanent (bad request, auth, model not found) — retrying won't
    // change the outcome. 429 means the upstream is explicitly throttling;
    // a 500ms in-call backoff would just hit the same limit. 5xx is the
    // upstream having a transient problem — the case retry is for.
    const cls: BlurbFailureClass =
      resp.status === 429 ? 'rate_limited' : resp.status >= 500 ? 'transient' : 'permanent';
    throw new BlurbError(cls, `gemini-${resp.status}`);
  }

  const body = (await resp.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: unknown }> } }>;
  };
  const text = body.candidates?.[0]?.content?.parts?.[0]?.text;
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > 240 ? `${trimmed.slice(0, 237)}…` : trimmed;
}
