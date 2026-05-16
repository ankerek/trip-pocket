import { runFetcherChain, AllFetchersFailedError } from '../src/fetchers/chain';
import type { LinkFetcher, FetchPostResult } from '../src/fetchers/types';

function okFetcher(name: string, result: FetchPostResult): LinkFetcher {
  return {
    name,
    fetch: jest.fn(async () => ({ kind: 'ok' as const, result })),
  };
}

function notApplicableFetcher(name: string): LinkFetcher {
  return {
    name,
    fetch: jest.fn(async () => ({ kind: 'not-applicable' as const })),
  };
}

function failedFetcher(name: string, retryable: boolean, msg = 'boom'): LinkFetcher {
  return {
    name,
    fetch: jest.fn(async () => ({
      kind: 'failed' as const,
      error: new Error(msg),
      retryable,
    })),
  };
}

const SAMPLE_RESULT: FetchPostResult = {
  platform: 'instagram',
  permalink: 'https://www.instagram.com/p/ABC/',
  caption: 'hi',
  imageUrls: ['https://cdn/img.jpg'],
  author: '@x',
};

const TARGET = new URL('https://www.instagram.com/p/ABC/');
const ENV = {} as any;
const CTX = { env: ENV };

describe('runFetcherChain', () => {
  it('returns the first ok outcome and stops calling later fetchers', async () => {
    const a = okFetcher('a', SAMPLE_RESULT);
    const b = okFetcher('b', { ...SAMPLE_RESULT, caption: 'should-not-see' });

    const out = await runFetcherChain([a, b], TARGET, 'instagram', CTX);

    expect(out.result.caption).toBe('hi');
    expect(out.via).toBe('a');
    expect(b.fetch).not.toHaveBeenCalled();
  });

  it('skips not-applicable fetchers silently', async () => {
    const a = notApplicableFetcher('a');
    const b = okFetcher('b', SAMPLE_RESULT);

    const out = await runFetcherChain([a, b], TARGET, 'instagram', CTX);

    expect(out.via).toBe('b');
    expect(out.attempts).toHaveLength(2);
  });

  it('advances past a retryable failure to the next fetcher (does NOT throw immediately)', async () => {
    const a = failedFetcher('a', true);
    const b = okFetcher('b', SAMPLE_RESULT);

    const out = await runFetcherChain([a, b], TARGET, 'instagram', CTX);

    expect(out.via).toBe('b');
    expect(a.fetch).toHaveBeenCalledTimes(1);
    expect(b.fetch).toHaveBeenCalledTimes(1);
  });

  it('advances past a non-retryable failure to the next fetcher', async () => {
    const a = failedFetcher('a', false);
    const b = okFetcher('b', SAMPLE_RESULT);

    const out = await runFetcherChain([a, b], TARGET, 'instagram', CTX);

    expect(out.via).toBe('b');
  });

  it('throws AllFetchersFailedError when every fetcher fails', async () => {
    const a = failedFetcher('a', false, 'first');
    const b = failedFetcher('b', false, 'second');

    await expect(runFetcherChain([a, b], TARGET, 'instagram', CTX)).rejects.toBeInstanceOf(
      AllFetchersFailedError,
    );
  });

  it('marks retryableExhausted=true if at least one failure was retryable', async () => {
    const a = failedFetcher('a', true);
    const b = failedFetcher('b', false);

    await expect(runFetcherChain([a, b], TARGET, 'instagram', CTX)).rejects.toMatchObject({
      retryableExhausted: true,
    });
  });

  it('marks retryableExhausted=false when no failure was retryable', async () => {
    const a = failedFetcher('a', false);
    const b = failedFetcher('b', false);

    await expect(runFetcherChain([a, b], TARGET, 'instagram', CTX)).rejects.toMatchObject({
      retryableExhausted: false,
    });
  });

  it('throws AllFetchersFailedError when every fetcher is not-applicable', async () => {
    const a = notApplicableFetcher('a');
    const b = notApplicableFetcher('b');

    await expect(runFetcherChain([a, b], TARGET, 'instagram', CTX)).rejects.toBeInstanceOf(
      AllFetchersFailedError,
    );
  });

  it('passes previousAttempts to each fetcher so later ones can inspect earlier outcomes', async () => {
    const a = failedFetcher('a', true, 'transient');
    const seenAttempts: unknown[] = [];
    const b: LinkFetcher = {
      name: 'b',
      fetch: jest.fn(async (_url, _platform, ctx) => {
        seenAttempts.push(ctx.previousAttempts);
        return { kind: 'ok' as const, result: SAMPLE_RESULT };
      }),
    };

    await runFetcherChain([a, b], TARGET, 'instagram', CTX);

    expect(seenAttempts).toHaveLength(1);
    expect(seenAttempts[0]).toMatchObject([
      { fetcher: 'a', outcome: { kind: 'failed', retryable: true } },
    ]);
  });
});
