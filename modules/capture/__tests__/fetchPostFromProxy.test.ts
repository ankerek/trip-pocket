import { getEntitlementUserId } from '@/lib/entitlement/userId';
import {
  FetchPostError,
  fetchPostFromProxy,
  workerErrorCodeFor,
} from '../fetchPostFromProxy';

jest.mock('@/lib/entitlement/userId', () => ({
  getEntitlementUserId: jest.fn(async () => '$RCAnonymousID:testuser'),
}));

const PROXY_URL = 'https://proxy.example.com/fetch-post';

function jsonResp(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const VALID_BODY = {
  platform: 'instagram',
  permalink: 'https://instagram.com/p/ABC/',
  caption: 'hello',
  imageUrls: [],
  author: null,
};

describe('fetchPostFromProxy — entitlement', () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    (getEntitlementUserId as jest.Mock).mockResolvedValue('$RCAnonymousID:testuser');
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('throws entitlement-required on 401', async () => {
    globalThis.fetch = jest.fn(async () =>
      jsonResp(401, { error: 'entitlement-required' }),
    ) as unknown as typeof fetch;

    await expect(fetchPostFromProxy('https://instagram.com/p/ABC/', PROXY_URL)).rejects.toMatchObject({
      classification: { kind: 'entitlement-required' },
    });
  });

  it('attaches X-RC-User-Id header on every fetch call', async () => {
    globalThis.fetch = jest.fn(async () =>
      jsonResp(200, VALID_BODY),
    ) as unknown as typeof fetch;

    await fetchPostFromProxy('https://instagram.com/p/ABC/', PROXY_URL);

    expect(globalThis.fetch).toHaveBeenCalledWith(
      PROXY_URL,
      expect.objectContaining({
        headers: expect.objectContaining({
          'X-RC-User-Id': '$RCAnonymousID:testuser',
        }),
      }),
    );
  });

  it('throws entitlement-required (without fetching) when getEntitlementUserId rejects', async () => {
    (getEntitlementUserId as jest.Mock).mockRejectedValueOnce(new Error('rc-not-ready'));
    globalThis.fetch = jest.fn() as unknown as typeof fetch;

    await expect(fetchPostFromProxy('https://instagram.com/p/ABC/', PROXY_URL)).rejects.toMatchObject({
      classification: { kind: 'entitlement-required' },
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe('workerErrorCodeFor', () => {
  it('returns "fetch-failed" for non-FetchPostError throwables', () => {
    expect(workerErrorCodeFor(new Error('boom'))).toBe('fetch-failed');
    expect(workerErrorCodeFor('string')).toBe('fetch-failed');
    expect(workerErrorCodeFor(null)).toBe('fetch-failed');
  });

  it('returns the permanent code for not-found / private / unsupported-url', () => {
    expect(
      workerErrorCodeFor(
        new FetchPostError('x', { kind: 'permanent', code: 'not-found' }),
      ),
    ).toBe('not-found');
    expect(
      workerErrorCodeFor(
        new FetchPostError('x', { kind: 'permanent', code: 'private' }),
      ),
    ).toBe('private');
    expect(
      workerErrorCodeFor(
        new FetchPostError('x', { kind: 'permanent', code: 'unsupported-url' }),
      ),
    ).toBe('unsupported-url');
  });

  it('collapses invalid-response into fetch-failed', () => {
    expect(
      workerErrorCodeFor(
        new FetchPostError('x', { kind: 'permanent', code: 'invalid-response' }),
      ),
    ).toBe('fetch-failed');
  });

  it('detects rate-limited from a 429 retryable message', () => {
    expect(
      workerErrorCodeFor(
        new FetchPostError('fetch-post-upstream-429', { kind: 'retryable' }),
      ),
    ).toBe('rate-limited');
  });

  it('returns fetch-failed for other retryable cases', () => {
    expect(
      workerErrorCodeFor(
        new FetchPostError('fetch-post-network: ...', { kind: 'retryable' }),
      ),
    ).toBe('fetch-failed');
    expect(
      workerErrorCodeFor(
        new FetchPostError('fetch-post-upstream-500', { kind: 'retryable' }),
      ),
    ).toBe('fetch-failed');
  });
});
