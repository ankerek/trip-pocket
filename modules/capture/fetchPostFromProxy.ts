// Client for the worker's POST /fetch-post endpoint. Same posture as
// modules/extraction/proxy.ts and modules/enrichment/proxy.ts: a thin
// timeout-and-classify wrapper around fetch + zod schema validation.

import { z } from 'zod';

export type FetchPostResult = {
  platform: 'instagram' | 'tiktok';
  permalink: string;
  caption: string;
  imageUrls: string[];
  author: string | null;
};

export type FetchPostErrorKind =
  | { kind: 'retryable' }
  | { kind: 'permanent'; code: PermanentCode };

export type PermanentCode =
  | 'not-found'
  | 'private'
  | 'unsupported-url'
  | 'invalid-response';

export class FetchPostError extends Error {
  constructor(
    message: string,
    public readonly classification: FetchPostErrorKind,
  ) {
    super(message);
    this.name = 'FetchPostError';
  }
}

const responseSchema = z.object({
  platform: z.enum(['instagram', 'tiktok']),
  permalink: z.string().url(),
  caption: z.string(),
  imageUrls: z.array(z.string().url()),
  author: z.string().nullable(),
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

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(proxyUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
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
