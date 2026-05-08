import { z } from 'zod';
import {
  EnrichmentError,
  type EnrichOutcome,
  type EnrichRequestPayload,
} from './enrichment';

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
    model: z.string().min(1),
  }),
  z.object({ status: z.literal('not-found') }),
]);

const DEFAULT_TIMEOUT_MS = 15000;

export type EnrichFromProxyOptions = {
  timeoutMs?: number;
};

export async function enrichFromProxy(
  payload: EnrichRequestPayload,
  proxyUrl: string,
  opts: EnrichFromProxyOptions = {},
): Promise<EnrichOutcome> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(proxyUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
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
    return { kind: 'not-found' };
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
    model: parsed.data.model,
  };
}
