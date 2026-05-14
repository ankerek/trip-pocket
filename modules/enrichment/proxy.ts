import { z } from 'zod';
import {
  EnrichmentError,
  type EnrichOutcome,
  type EnrichRequestPayload,
} from './enrichment';
import { getEntitlementUserId } from '@/lib/entitlement/userId';

// Closed-vocab debug echo from the worker. Optional because an older deployed
// worker that hasn't shipped the v0.4 echo will omit it. See
// docs/superpowers/specs/2026-05-13-pipeline-observability-design.md
// §Worker debug echo.
const debugSchema = z.object({
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

export type EnrichDebug = z.infer<typeof debugSchema>;

const responseSchema = z.union([
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
    // Authoritative geographic fields from Google Places `addressComponents`.
    // Null when missing on Google's side; COALESCE in the write path then
    // preserves the LLM value.
    city: z.string().nullable(),
    country_code: z.string().regex(/^[A-Z]{2}$/).nullable(),
    model: z.string().min(1),
    _debug: debugSchema.optional(),
  }),
  z.object({
    status: z.literal('not-found'),
    _debug: debugSchema.optional(),
  }),
]);

// 25s budget for the full /enrich round-trip. The worker does three
// sub-steps (Places searchText, Places details, Gemini blurb) and the
// in-call blurb retry can add another ~500ms + one Gemini attempt. 15s
// was tight enough that slow-but-recovering Gemini calls hit AbortError;
// 25s gives the worker headroom while still surfacing genuinely-hung
// upstreams as `retryable` failures within a single foreground.
const DEFAULT_TIMEOUT_MS = 25000;

export type EnrichFromProxyOptions = {
  timeoutMs?: number;
};

export async function enrichFromProxy(
  payload: EnrichRequestPayload,
  proxyUrl: string,
  opts: EnrichFromProxyOptions = {},
): Promise<EnrichOutcome> {
  // Fail fast if RC hasn't initialised — route through the paused-state
  // machinery the same way a 401 from the worker would.
  let userId: string;
  try {
    userId = await getEntitlementUserId();
  } catch {
    throw new EnrichmentError('enrich-userid-unavailable', 'entitlement-required');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(proxyUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-RC-User-Id': userId },
      // Wire format keeps the legacy `extracted_place_id` key; the worker
      // uses it for tracing only and is unaware of the client's places-first
      // restructure. Internally we now key off the canonical place row.
      body: JSON.stringify({
        extracted_place_id: payload.place_id,
        name: payload.name,
        city: payload.city,
        address: payload.address,
        ocr_caption: payload.ocr_caption,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    throw new EnrichmentError(`enrich-network: ${String(err)}`, 'retryable');
  } finally {
    clearTimeout(timeout);
  }

  if (response.status === 401) {
    throw new EnrichmentError('enrich-entitlement-required', 'entitlement-required');
  }
  if (response.status === 429) {
    throw new EnrichmentError('enrich-rate-limited', 'rate-limited');
  }
  if (response.status >= 500) {
    throw new EnrichmentError(`enrich-upstream-${response.status}`, 'retryable');
  }
  if (response.status >= 400) {
    throw new EnrichmentError(`enrich-client-${response.status}`, 'permanent');
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new EnrichmentError('enrich-non-json', 'retryable');
  }

  const parsed = responseSchema.safeParse(body);
  if (!parsed.success) {
    throw new EnrichmentError('enrich-schema-violation', 'retryable');
  }

  if (parsed.data.status === 'not-found') {
    return { kind: 'not-found', _debug: parsed.data._debug };
  }
  return {
    kind: 'enriched',
    external_place_id: parsed.data.external_place_id,
    latitude: parsed.data.latitude,
    longitude: parsed.data.longitude,
    formatted_address: parsed.data.formatted_address,
    photo_name: parsed.data.photo_name,
    description: parsed.data.description,
    rating: parsed.data.rating,
    price_level: parsed.data.price_level,
    external_url: parsed.data.external_url,
    city: parsed.data.city,
    country_code: parsed.data.country_code,
    model: parsed.data.model,
    _debug: parsed.data._debug,
  };
}
