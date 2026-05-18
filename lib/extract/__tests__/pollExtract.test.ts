import { pollExtract, type ExtractState } from '../pollExtract';

const HASH = 'a'.repeat(64);
const VALID_ID = '$RCAnonymousID:0123456789abcdef0123456789abcdef';

function makeFetch(responses: Response[]): typeof fetch {
  let i = 0;
  // Clone before returning — Response.json() consumes the body, so reusing
  // the same instance across calls fails on the second consumption.
  return jest.fn(
    async () => responses[Math.min(i++, responses.length - 1)]!.clone(),
  ) as unknown as typeof fetch;
}

function rjson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('pollExtract', () => {
  let original: typeof fetch;
  beforeEach(() => {
    original = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = original;
  });

  it('returns done on the first poll when the cache is hot', async () => {
    globalThis.fetch = makeFetch([
      rjson({ contentHash: HASH, status: 'done', places: [], model: 'm' }, 200),
    ]);
    const result = await pollExtract({
      contentHash: HASH,
      rcUserId: VALID_ID,
      workerBase: 'https://w.test',
      maxAttempts: 3,
      delayMs: 1,
    });
    expect(result.status).toBe('done');
  });

  it('polls through pending → partial → done', async () => {
    globalThis.fetch = makeFetch([
      rjson({ contentHash: HASH, status: 'pending' }, 200),
      rjson({ contentHash: HASH, status: 'partial', caption: 'cap' }, 200),
      rjson(
        {
          contentHash: HASH,
          status: 'done',
          places: [],
          model: 'm',
        },
        200,
      ),
    ]);
    const result = await pollExtract({
      contentHash: HASH,
      rcUserId: VALID_ID,
      workerBase: 'https://w.test',
      maxAttempts: 5,
      delayMs: 1,
    });
    expect(result.status).toBe('done');
  });

  it('returns the error state when the worker reports a terminal error', async () => {
    globalThis.fetch = makeFetch([
      rjson({ contentHash: HASH, status: 'error', error: 'fetch-failed' }, 200),
    ]);
    const result = await pollExtract({
      contentHash: HASH,
      rcUserId: VALID_ID,
      workerBase: 'https://w.test',
      maxAttempts: 5,
      delayMs: 1,
    });
    expect(result.status).toBe('error');
  });

  it('returns missing on 404 when triggerOnMissing is false', async () => {
    globalThis.fetch = makeFetch([
      rjson({ contentHash: HASH, status: 'missing' }, 404),
    ]);
    const result = await pollExtract({
      contentHash: HASH,
      rcUserId: VALID_ID,
      workerBase: 'https://w.test',
      maxAttempts: 1,
      delayMs: 1,
    });
    expect(result.status).toBe('missing');
  });

  it('on 404 with triggerOnMissing: POSTs /extract, then re-polls', async () => {
    const calls: Array<{ url: string; method: string }> = [];
    globalThis.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      calls.push({ url, method: init?.method ?? 'GET' });
      if (calls.length === 1) return rjson({ status: 'missing' }, 404);
      if (calls.length === 2) return rjson({ status: 'pending' }, 202);
      return rjson({ status: 'done', places: [], model: 'm' }, 200);
    }) as unknown as typeof fetch;
    const result = await pollExtract({
      contentHash: HASH,
      rcUserId: VALID_ID,
      workerBase: 'https://w.test',
      maxAttempts: 5,
      delayMs: 1,
      triggerOnMissing: true,
      url: 'https://www.instagram.com/reel/x/',
    });
    expect(result.status).toBe('done');
    expect(calls[1]?.method).toBe('POST');
    expect(calls[1]?.url).toBe('https://w.test/extract');
  });

  it('returns timeout state when max attempts exhausted on pending', async () => {
    globalThis.fetch = makeFetch([rjson({ contentHash: HASH, status: 'pending' }, 200)]);
    const result = await pollExtract({
      contentHash: HASH,
      rcUserId: VALID_ID,
      workerBase: 'https://w.test',
      maxAttempts: 2,
      delayMs: 1,
    });
    expect(result.status).toBe('timeout');
  });

  it('sends X-RC-User-Id on every request', async () => {
    let receivedHeader: string | null = null;
    globalThis.fetch = jest.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      receivedHeader = headers.get('X-RC-User-Id');
      return rjson({ status: 'done', places: [], model: 'm' }, 200);
    }) as unknown as typeof fetch;
    await pollExtract({
      contentHash: HASH,
      rcUserId: VALID_ID,
      workerBase: 'https://w.test',
      maxAttempts: 1,
      delayMs: 1,
    });
    expect(receivedHeader).toBe(VALID_ID);
  });

  it('treats unknown statuses as terminal (does not poll forever on schema drift)', async () => {
    globalThis.fetch = makeFetch([
      rjson({ contentHash: HASH, status: 'unrecognised-status' }, 200),
    ]);
    const result = (await pollExtract({
      contentHash: HASH,
      rcUserId: VALID_ID,
      workerBase: 'https://w.test',
      maxAttempts: 1,
      delayMs: 1,
    })) as ExtractState;
    expect(result.status).toBe('error');
  });

  it('retriggers via POST when the first GET returns pending with a stale startedAt', async () => {
    // ctx.waitUntil exhausted on a prior worker isolate → KV stuck on
    // pending. The orchestrator's stale-pending check will re-run when a
    // new POST arrives, so pollExtract POSTs once before continuing to
    // poll.
    const calls: Array<{ url: string; method: string }> = [];
    const stalePending = {
      contentHash: HASH,
      status: 'pending',
      startedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    };
    globalThis.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      calls.push({ url, method });
      // GET #1 → stale pending; GET #2 → done; POST is the retrigger.
      if (method === 'POST') return rjson({ status: 'pending' }, 202);
      if (calls.filter((c) => c.method === 'GET').length === 1) {
        return rjson(stalePending, 200);
      }
      return rjson({ status: 'done', places: [], model: 'm' }, 200);
    }) as unknown as typeof fetch;

    const result = await pollExtract({
      contentHash: HASH,
      rcUserId: VALID_ID,
      workerBase: 'https://w.test',
      maxAttempts: 5,
      delayMs: 1,
      triggerOnMissing: true,
      url: 'https://www.instagram.com/reel/a/',
    });
    expect(result.status).toBe('done');
    const posts = calls.filter((c) => c.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0]?.url).toBe('https://w.test/extract');
  });

  it('does NOT retrigger when pending state is fresh (still within stale window)', async () => {
    const calls: Array<{ method: string }> = [];
    const freshPending = {
      contentHash: HASH,
      status: 'pending',
      startedAt: new Date().toISOString(),
    };
    globalThis.fetch = jest.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ method });
      if (method === 'POST') return rjson({ status: 'pending' }, 202);
      if (calls.filter((c) => c.method === 'GET').length < 3) return rjson(freshPending, 200);
      return rjson({ status: 'done', places: [], model: 'm' }, 200);
    }) as unknown as typeof fetch;
    const result = await pollExtract({
      contentHash: HASH,
      rcUserId: VALID_ID,
      workerBase: 'https://w.test',
      maxAttempts: 5,
      delayMs: 1,
      triggerOnMissing: true,
      url: 'https://www.instagram.com/reel/a/',
    });
    expect(result.status).toBe('done');
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('only retriggers stale-pending once per pollExtract call', async () => {
    const stalePending = {
      contentHash: HASH,
      status: 'pending',
      startedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    };
    const calls: Array<{ method: string }> = [];
    globalThis.fetch = jest.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ method });
      // Permanently stale → if pollExtract retriggered every cycle, we'd
      // see N POSTs. We expect exactly one.
      if (method === 'POST') return rjson({ status: 'pending' }, 202);
      return rjson(stalePending, 200);
    }) as unknown as typeof fetch;
    const result = await pollExtract({
      contentHash: HASH,
      rcUserId: VALID_ID,
      workerBase: 'https://w.test',
      maxAttempts: 4,
      delayMs: 1,
      triggerOnMissing: true,
      url: 'https://www.instagram.com/reel/a/',
    });
    expect(result.status).toBe('timeout');
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });
});
