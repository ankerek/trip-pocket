import { z } from 'zod';
import {
  ExtractionError,
  type ExtractionErrorKind,
  type ExtractionResult,
} from './extraction';

const responseSchema = z.object({
  places: z.array(
    z.object({
      name: z.string().min(1),
      city: z.string(),
      address: z.string(),
      category: z.enum(['place', 'food', 'activity']),
      // ISO-3166-1 alpha-2 uppercase, or empty when the LLM couldn't infer.
      // The worker is the single point of regex enforcement; here we accept
      // the same surface and treat anything outside it as a schema violation
      // (which the adapter maps to retryable).
      country_code: z.string().regex(/^([A-Z]{2})?$/),
    }),
  ),
  model: z.string().min(1),
});

export type ExtractFromProxyOptions = {
  /** Wall-clock timeout for the whole request. Default 10s. */
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_RETRY_AFTER_MS = 60000;
// Anything past this on 429 is treated as a 5xx (retryable, budget-consuming)
// — defends against a misbehaving upstream wedging a row in `pending`.
const RETRY_AFTER_CEILING_MS = 5 * 60 * 1000;

export async function extractFromProxy(
  ocrText: string,
  proxyUrl: string,
  opts: ExtractFromProxyOptions = {},
): Promise<ExtractionResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(proxyUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ocr_text: ocrText }),
      signal: controller.signal,
    });
  } catch (err) {
    // Network error, DNS failure, TLS error, or AbortError (timeout) — all
    // transient. Bubble as retryable so the extractor consumes one budget
    // slot and tries again.
    throw new ExtractionError(`extract-network: ${String(err)}`, { kind: 'retryable' });
  } finally {
    clearTimeout(timeout);
  }

  if (response.status === 429) {
    throw new ExtractionError('extract-rate-limited', classifyRateLimit(response));
  }

  if (response.status >= 500) {
    throw new ExtractionError(`extract-upstream-${response.status}`, { kind: 'retryable' });
  }

  if (response.status >= 400) {
    throw new ExtractionError(`extract-client-${response.status}`, { kind: 'permanent' });
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ExtractionError('extract-non-json', { kind: 'retryable' });
  }

  const parsed = responseSchema.safeParse(body);
  if (!parsed.success) {
    throw new ExtractionError('extract-schema-violation', { kind: 'retryable' });
  }

  return { places: parsed.data.places, model: parsed.data.model };
}

function classifyRateLimit(response: Response): ExtractionErrorKind {
  const header = response.headers.get('retry-after');
  if (header) {
    // Retry-After can be HTTP-date or seconds. We only honor the
    // seconds form here; an HTTP-date upstream would land here too,
    // parseInt would NaN, and we'd fall through to the default.
    const seconds = parseInt(header, 10);
    if (Number.isFinite(seconds) && seconds > 0) {
      const ms = seconds * 1000;
      if (ms > RETRY_AFTER_CEILING_MS) {
        // Defensive: treat absurd Retry-After as a 5xx-style retry to
        // avoid wedging the row indefinitely.
        return { kind: 'retryable' };
      }
      return { kind: 'deferred', retryAfterMs: ms };
    }
  }
  return { kind: 'deferred', retryAfterMs: DEFAULT_RETRY_AFTER_MS };
}
