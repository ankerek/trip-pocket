import { z } from 'zod';
import type { Env } from './index';
import { GEMINI_MODEL } from './prompt';

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
    model: z.string(),
  }),
  z.object({ status: z.literal('not-found') }),
]);

export type EnrichResponse = z.infer<typeof enrichResponseSchema>;

const JSON_HEADERS = { 'content-type': 'application/json' } as const;

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { ...JSON_HEADERS, ...(init.headers ?? {}) },
  });
}

function errorResponse(error: string, status: number, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { ...JSON_HEADERS, ...extra },
  });
}

export async function handleEnrich(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return errorResponse('method-not-allowed', 405);

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
      return jsonResponse({ status: 'not-found' satisfies EnrichResponse['status'] });
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
  const description = await safeBuildBlurb(parsed.data, details, env);

  const response: EnrichResponse = {
    status: 'enriched',
    external_place_id: details.id,
    latitude: details.latitude,
    longitude: details.longitude,
    formatted_address: details.formattedAddress,
    photo_name: details.photoName,
    description,
    rating: details.rating,
    price_level: details.priceLevel,
    external_url: details.googleMapsUri,
    model: GEMINI_MODEL,
  };
  return jsonResponse(response);
}

// --- Google Places client ---

class PlacesError extends Error {
  constructor(public readonly status: number, message: string) {
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
  ].join(',');

  const resp = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`, {
    method: 'GET',
    headers: {
      'X-Goog-Api-Key': env.GOOGLE_PLACES_API_KEY,
      'X-Goog-FieldMask': fields,
    },
  });

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
  };
  if (typeof obj.id !== 'string') {
    throw new PlacesError(502, 'placeDetails missing id');
  }

  return {
    id: obj.id,
    latitude:
      typeof obj.location?.latitude === 'number' ? obj.location.latitude : null,
    longitude:
      typeof obj.location?.longitude === 'number' ? obj.location.longitude : null,
    formattedAddress:
      typeof obj.formattedAddress === 'string' ? obj.formattedAddress : null,
    photoName:
      Array.isArray(obj.photos) && typeof obj.photos[0]?.name === 'string'
        ? obj.photos[0].name
        : null,
    rating: typeof obj.rating === 'number' ? obj.rating : null,
    priceLevel: priceLevelToInt(obj.priceLevel),
    googleMapsUri: typeof obj.googleMapsUri === 'string' ? obj.googleMapsUri : null,
    displayName: typeof obj.displayName?.text === 'string' ? obj.displayName.text : null,
    types: Array.isArray(obj.types) ? obj.types.filter((t): t is string => typeof t === 'string') : [],
    editorialSummary:
      typeof obj.editorialSummary?.text === 'string' ? obj.editorialSummary.text : null,
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

async function safeBuildBlurb(
  req: EnrichRequest,
  details: PlaceDetails,
  env: Env,
): Promise<string | null> {
  try {
    return await buildBlurb(req, details, env);
  } catch (err) {
    console.error('extract-proxy/enrich: blurb-failed', String(err));
    return null;
  }
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

  const resp = await fetch(gatewayUrl, {
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

  if (!resp.ok) {
    throw new Error(`gemini-${resp.status}`);
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
