import type { Env } from '../index';

export type Platform = 'instagram' | 'tiktok';

export type FetchPostResult = {
  platform: Platform;
  permalink: string;
  caption: string;
  imageUrls: string[];
  author: string | null;
};

export type FetcherOutcome =
  | {
      kind: 'ok';
      result: FetchPostResult;
      // Platform-specific debug payload. The HTTP handler attaches it to the
      // response under `_debug` (closed-vocab fetchPostDebugSchema). The chain
      // runner forwards it as-is.
      dispatch?: unknown;
      // Cache-Control hint used by the handler to compute s-maxage. Currently
      // 'apify' = 7d, anything else = 1d.
      cacheKind?: 'og' | 'apify';
    }
  | { kind: 'not-applicable' }
  | { kind: 'failed'; error: Error; retryable: boolean };

export type FetcherAttempt = {
  fetcher: string;
  outcome: FetcherOutcome;
};

export type FetcherContext = {
  env: Env;
  previousAttempts?: FetcherAttempt[];
};

export type LinkFetcher = {
  name: string;
  fetch(url: URL, platform: Platform, ctx: FetcherContext): Promise<FetcherOutcome>;
};
