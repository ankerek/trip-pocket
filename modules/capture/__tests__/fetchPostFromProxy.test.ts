import {
  FetchPostError,
  workerErrorCodeFor,
} from '../fetchPostFromProxy';

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
