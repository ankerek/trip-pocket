import { z } from 'zod';
import {
  ExtractionError,
  type ExtractionErrorKind,
  type ExtractionResult,
} from './extraction';
import { getEntitlementUserId } from '@/lib/entitlement/userId';

const responseSchema = z.object({
  places: z.array(
    z.object({
      name: z.string().min(1),
      city: z.string(),
      address: z.string(),
      category: z.enum(['place', 'food', 'activity']),
      // Lenient per-place coercion. The worker normalises country_code
      // already; this is defense-in-depth for the case where the worker
      // version lags the client. Any non-conforming value (missing,
      // wrong case, 3-letter, full name, non-string) becomes empty
      // string. Empty maps to NULL at the storage boundary in
      // extraction.ts. A single bad apple never blows up the whole batch.
      country_code: z.unknown().transform((v) => {
        if (typeof v !== 'string') return '';
        const upper = v.trim().toUpperCase();
        return /^[A-Z]{2}$/.test(upper) ? upper : '';
      }),
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
  // Fail fast if RC hasn't initialised — route through the paused-state
  // machinery the same way a 401 from the worker would.
  let userId: string;
  try {
    userId = await getEntitlementUserId();
  } catch {
    throw new ExtractionError('extract-userid-unavailable', { kind: 'entitlement-required' });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(proxyUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-RC-User-Id': userId,
      },
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

  if (response.status === 401) {
    throw new ExtractionError('extract-entitlement-required', { kind: 'entitlement-required' });
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
