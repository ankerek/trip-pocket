import type {
  FetcherAttempt,
  FetcherContext,
  FetchPostResult,
  LinkFetcher,
  Platform,
} from './types';

export class AllFetchersFailedError extends Error {
  constructor(
    public readonly attempts: FetcherAttempt[],
    public readonly retryableExhausted: boolean,
  ) {
    super(`all-fetchers-failed (retryableExhausted=${retryableExhausted})`);
    this.name = 'AllFetchersFailedError';
  }
}

export type ChainResult = {
  result: FetchPostResult;
  via: string;
  attempts: FetcherAttempt[];
  dispatch?: unknown;
  cacheKind?: 'og' | 'apify';
};

export async function runFetcherChain(
  fetchers: LinkFetcher[],
  url: URL,
  platform: Platform,
  ctx: Omit<FetcherContext, 'previousAttempts'>,
): Promise<ChainResult> {
  const attempts: FetcherAttempt[] = [];
  for (const fetcher of fetchers) {
    const outcome = await fetcher.fetch(url, platform, {
      ...ctx,
      previousAttempts: [...attempts],
    });
    attempts.push({ fetcher: fetcher.name, outcome });
    if (outcome.kind === 'ok') {
      return {
        result: outcome.result,
        via: fetcher.name,
        attempts,
        dispatch: outcome.dispatch,
        cacheKind: outcome.cacheKind,
      };
    }
    // retryable or non-retryable failures, and not-applicable, all advance.
  }
  const retryableExhausted = attempts.some(
    (a) => a.outcome.kind === 'failed' && a.outcome.retryable,
  );
  throw new AllFetchersFailedError(attempts, retryableExhausted);
}
