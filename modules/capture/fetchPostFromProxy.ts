// Client for the worker's POST /fetch-post endpoint. Same posture as
// modules/extraction/proxy.ts and modules/enrichment/proxy.ts: a thin
// timeout-and-classify wrapper around fetch + zod schema validation.

import { z } from 'zod';
import { getEntitlementUserId } from '@/lib/entitlement/userId';

// Closed-vocab dispatch info echoed by the worker so the phone can surface
// which path it took (og-only / Apify carousel / Apify fallback / TikTok
// oEmbed / soft-degrade) into the pipeline-log firehose. Optional because a
// worker that hasn't been redeployed with the v0.4 echo will omit it. See
// docs/superpowers/specs/2026-05-13-pipeline-observability-design.md
// §Worker debug echo.
export type FetchPostDebug = {
  // Phone Zod accepts the union of old + new values during the rollout
  // window so a not-yet-upgraded worker (still emitting `tiktok_og` /
  // `tiktok_oembed`) parses cleanly. The old values can be dropped once the
  // worker has been on the new dispatch for ~1 week.
  route:
    | 'og_only'
    | 'og_only_apify_disabled'
    | 'og_then_apify_carousel'
    | 'og_then_apify_unknown_efg'
    | 'apify_only_reel'
    | 'og_failed_apify_fallback'
    | 'tiktok_og'
    | 'tiktok_oembed'
    | 'tiktok_rehyd_photo'
    | 'tiktok_rehyd_video'
    | 'tiktok_oembed_fallback';
  ogOutcome:
    | 'ok'
    | 'empty'
    | 'not_found'
    | 'private'
    | 'unsupported_url'
    | 'rate_limited'
    | 'timeout'
    | 'network'
    | 'upstream_5xx'
    | 'not_called';
  apifyOutcome:
    | 'not_called'
    | 'not_configured'
    | 'ok'
    | 'empty'
    | 'carousel_no_children'
    | 'auth'
    | 'actor_not_found'
    | 'rate_limited'
    | 'timeout'
    | 'network'
    | 'upstream'
    | 'non_json';
  cacheHit: boolean;
};

export type FetchPostResult = {
  platform: 'instagram' | 'tiktok';
  permalink: string;
  caption: string;
  imageUrls: string[];
  author: string | null;
  // Populated for video posts (IG Reels / top-level TikTok videos). The URL
  // is signed and expires within hours; the processor consumes it
  // synchronously during the URL-share flow and never stores it.
  videoUrl?: string | null;
  videoDuration?: number | null;
  _debug?: FetchPostDebug;
};

export type FetchPostErrorKind =
  | { kind: 'retryable' }
  | { kind: 'permanent'; code: PermanentCode }
  | { kind: 'entitlement-required' };

export type PermanentCode = 'not-found' | 'private' | 'unsupported-url' | 'invalid-response';

export class FetchPostError extends Error {
  constructor(
    message: string,
    public readonly classification: FetchPostErrorKind,
  ) {
    super(message);
    this.name = 'FetchPostError';
  }
}

const debugSchema = z.object({
  route: z.enum([
    'og_only',
    'og_only_apify_disabled',
    'og_then_apify_carousel',
    'og_then_apify_unknown_efg',
    'apify_only_reel',
    'og_failed_apify_fallback',
    'tiktok_og',
    'tiktok_oembed',
    'tiktok_rehyd_photo',
    'tiktok_rehyd_video',
    'tiktok_oembed_fallback',
  ]),
  ogOutcome: z.enum([
    'ok',
    'empty',
    'not_found',
    'private',
    'unsupported_url',
    'rate_limited',
    'timeout',
    'network',
    'upstream_5xx',
    'not_called',
  ]),
  apifyOutcome: z.enum([
    'not_called',
    'not_configured',
    'ok',
    'empty',
    'carousel_no_children',
    'auth',
    'actor_not_found',
    'rate_limited',
    'timeout',
    'network',
    'upstream',
    'non_json',
  ]),
  cacheHit: z.boolean(),
});

const responseSchema = z.object({
  platform: z.enum(['instagram', 'tiktok']),
  permalink: z.string().url(),
  caption: z.string(),
  imageUrls: z.array(z.string().url()),
  author: z.string().nullable(),
  videoUrl: z.string().url().nullable().optional(),
  videoDuration: z.number().nonnegative().nullable().optional(),
  _debug: debugSchema.optional(),
});

const DEFAULT_TIMEOUT_MS = 15000;

export type FetchPostOptions = {
  timeoutMs?: number;
};

export async function fetchPostFromProxy(
  url: string,
  proxyUrl: string,
  opts: FetchPostOptions = {},
): Promise<FetchPostResult> {
  if (proxyUrl.length === 0) {
    // Match the extractor/enricher posture: an unconfigured proxy fails
    // loudly on first call, surfacing in dev as a retryable network error.
    throw new FetchPostError('fetch-post-proxy-not-configured', { kind: 'retryable' });
  }

  // Fail fast if RC hasn't initialised — route through the paused-state
  // machinery the same way a 401 from the worker would.
  let userId: string;
  try {
    userId = await getEntitlementUserId();
  } catch {
    throw new FetchPostError('fetch-post-userid-unavailable', { kind: 'entitlement-required' });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(proxyUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-RC-User-Id': userId },
      body: JSON.stringify({ url }),
      signal: controller.signal,
    });
  } catch (err) {
    // Network errors, DNS failures, TLS errors, AbortError (timeout) — all
    // retryable. The processor consumes one retry slot and tries again.
    throw new FetchPostError(`fetch-post-network: ${String(err)}`, { kind: 'retryable' });
  } finally {
    clearTimeout(timeout);
  }

  if (response.status === 401) {
    throw new FetchPostError('fetch-post-entitlement-required', { kind: 'entitlement-required' });
  }

  if (response.status === 404 || response.status === 403 || response.status === 400) {
    // 400 unsupported-url, 403 private, 404 not-found — none retryable.
    let code: PermanentCode = 'invalid-response';
    try {
      const body = (await response.json()) as { error?: unknown };
      if (typeof body?.error === 'string') {
        if (body.error === 'not-found') code = 'not-found';
        else if (body.error === 'private') code = 'private';
        else if (body.error === 'unsupported-url') code = 'unsupported-url';
      }
    } catch {
      // body is not JSON; leave code as default
    }
    throw new FetchPostError(`fetch-post-${response.status}`, {
      kind: 'permanent',
      code,
    });
  }

  if (response.status === 429 || response.status >= 500) {
    throw new FetchPostError(`fetch-post-upstream-${response.status}`, {
      kind: 'retryable',
    });
  }

  if (!response.ok) {
    // Any unexpected non-2xx → retryable. Worker is the choke point;
    // anything not enumerated above is a worker bug, treat as transient.
    throw new FetchPostError(`fetch-post-status-${response.status}`, {
      kind: 'retryable',
    });
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new FetchPostError('fetch-post-non-json', { kind: 'retryable' });
  }

  const parsed = responseSchema.safeParse(body);
  if (!parsed.success) {
    throw new FetchPostError('fetch-post-schema-violation', {
      kind: 'permanent',
      code: 'invalid-response',
    });
  }
  return parsed.data;
}

// Maps a fetchPost failure to the closed-vocab `worker_error_code` Sentry tag
// the pipeline-observability spec defines. Anything that isn't an explicit
// not-found / private / unsupported-url collapses into `fetch-failed` —
// 429s, 5xx, network failures, and schema violations all land there.
export type WorkerErrorCode =
  | 'fetch-failed'
  | 'not-found'
  | 'private'
  | 'unsupported-url'
  | 'rate-limited';

export function workerErrorCodeFor(err: unknown): WorkerErrorCode {
  if (!(err instanceof FetchPostError)) return 'fetch-failed';
  if (err.classification.kind === 'permanent') {
    const code = err.classification.code;
    if (code === 'not-found' || code === 'private' || code === 'unsupported-url') {
      return code;
    }
    return 'fetch-failed';
  }
  // Retryable cases. Distinguish CF rate-limiter trips (429) from generic
  // upstream/network failures so the Sentry filter `worker_error_code:
  // rate-limited` is queryable.
  if (err.message.includes('-429')) return 'rate-limited';
  return 'fetch-failed';
}
