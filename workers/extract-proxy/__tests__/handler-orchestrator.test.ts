import { handleExtractPost, handleExtractGet } from '../src/index';
import type { Env } from '../src/index';

const HASH = 'a'.repeat(64);
const VALID_ID = '$RCAnonymousID:0123456789abcdef0123456789abcdef';

function makeKv() {
  const store = new Map<string, string>();
  return {
    store,
    async put(key: string, value: string): Promise<void> {
      store.set(key, value);
    },
    async get(key: string): Promise<string | null> {
      return store.get(key) ?? null;
    },
  };
}

function makeEnv(kv = makeKv()): Env {
  return {
    GEMINI_API_KEY: 'k',
    GOOGLE_PLACES_API_KEY: 'k',
    CF_ACCOUNT_ID: 'a',
    AI_GATEWAY_NAME: 'g',
    CF_AIG_TOKEN: 't',
    RATE_LIMIT: { limit: async () => ({ success: true }) } as Env['RATE_LIMIT'],
    RC_REST_API_KEY: 'rc',
    EXTRACT_STATE: kv as unknown as KVNamespace,
    // No-op queue stub. These tests assert handleExtractPost's HTTP
    // shape and only care that `ctx.waitUntil` was called once with the
    // pipeline kickoff promise — they don't drain that promise, so the
    // queue.send inside kickOffPipeline must not throw or the rejection
    // tears down the test worker.
    EXTRACT_QUEUE: {
      async send() {
        return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
      },
      async sendBatch() {
        return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
      },
      async metrics() {
        return { backlogCount: 0, backlogBytes: 0 };
      },
    } as Env['EXTRACT_QUEUE'],
  };
}

const RC_ACTIVE = new Response(
  JSON.stringify({
    subscriber: {
      entitlements: { pro: { expires_date: new Date(Date.now() + 60_000).toISOString() } },
    },
  }),
  { status: 200, headers: { 'content-type': 'application/json' } },
);

function setupCachesAndRcStub(): () => void {
  const store = new Map<string, Response>();
  // @ts-expect-error — Workers cache polyfill for tests
  globalThis.caches = {
    default: {
      async match(key: Request): Promise<Response | undefined> {
        const r = store.get(key.url);
        return r ? r.clone() : undefined;
      },
      async put(key: Request, value: Response): Promise<void> {
        store.set(key.url, value.clone());
      },
    },
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.startsWith('https://api.revenuecat.com/v1/subscribers/')) {
      return RC_ACTIVE.clone();
    }
    throw new Error('unexpected fetch in test: ' + url);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

function postExtract(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('https://proxy.example.com/extract', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'CF-Connecting-IP': '1.2.3.4',
      'X-RC-User-Id': VALID_ID,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function getExtract(hash: string, headers: Record<string, string> = {}): Request {
  return new Request(`https://proxy.example.com/extract/${hash}`, {
    method: 'GET',
    headers: {
      'X-RC-User-Id': VALID_ID,
      ...headers,
    },
  });
}

describe('handleExtractPost', () => {
  let restore: () => void;
  beforeEach(() => {
    restore = setupCachesAndRcStub();
  });
  afterEach(() => restore());

  it('returns 202 pending and schedules orchestrate on cache miss', async () => {
    const env = makeEnv();
    const ctx = { waitUntil: jest.fn() };
    const res = await handleExtractPost(
      postExtract({
        contentHash: HASH,
        kind: 'url',
        url: 'https://www.instagram.com/reel/a/',
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('pending');
    expect(ctx.waitUntil).toHaveBeenCalledTimes(1);
  });

  it('returns 200 with cached state immediately on hit (no waitUntil)', async () => {
    const kv = makeKv();
    kv.store.set(
      `state:${HASH}`,
      JSON.stringify({
        contentHash: HASH,
        status: 'done',
        places: [],
        model: 'cached',
      }),
    );
    const env = makeEnv(kv);
    const ctx = { waitUntil: jest.fn() };
    const res = await handleExtractPost(
      postExtract({
        contentHash: HASH,
        kind: 'url',
        url: 'https://www.instagram.com/reel/a/',
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; model: string };
    expect(body.status).toBe('done');
    expect(body.model).toBe('cached');
    expect(ctx.waitUntil).not.toHaveBeenCalled();
  });

  it('short-circuits with 200 when cached state is error (terminal)', async () => {
    const kv = makeKv();
    kv.store.set(
      `state:${HASH}`,
      JSON.stringify({
        contentHash: HASH,
        status: 'error',
        error: 'extract-failed',
        startedAt: '2026-05-18T00:00:00.000Z',
      }),
    );
    const env = makeEnv(kv);
    const ctx = { waitUntil: jest.fn() };
    const res = await handleExtractPost(
      postExtract({ contentHash: HASH, kind: 'url', url: 'https://www.instagram.com/p/a/' }),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; error?: string };
    expect(body.status).toBe('error');
    expect(body.error).toBe('extract-failed');
    expect(ctx.waitUntil).not.toHaveBeenCalled();
  });

  it('returns 202 and re-schedules orchestrate when cached state is partial', async () => {
    // Stale-pending recovery: an isolate that died between writing
    // `partial` and the terminal write would otherwise leave the hash
    // stuck for 72h, because the cached state short-circuit would block
    // every subsequent POST from reaching orchestrate(). Partial must
    // fall through.
    const kv = makeKv();
    kv.store.set(
      `state:${HASH}`,
      JSON.stringify({
        contentHash: HASH,
        status: 'partial',
        caption: 'cap',
        coverUrl: 'https://cdn/c.jpg',
        startedAt: '2026-05-18T00:00:00.000Z',
      }),
    );
    const env = makeEnv(kv);
    const ctx = { waitUntil: jest.fn() };
    const res = await handleExtractPost(
      postExtract({ contentHash: HASH, kind: 'url', url: 'https://www.instagram.com/p/a/' }),
      env,
      ctx,
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as { status: string; caption?: string };
    expect(body.status).toBe('partial');
    expect(body.caption).toBe('cap');
    expect(ctx.waitUntil).toHaveBeenCalledTimes(1);
  });

  it('returns 202 and re-schedules orchestrate when cached state is pending', async () => {
    const kv = makeKv();
    kv.store.set(
      `state:${HASH}`,
      JSON.stringify({
        contentHash: HASH,
        status: 'pending',
        startedAt: '2026-05-18T00:00:00.000Z',
      }),
    );
    const env = makeEnv(kv);
    const ctx = { waitUntil: jest.fn() };
    const res = await handleExtractPost(
      postExtract({ contentHash: HASH, kind: 'url', url: 'https://www.instagram.com/p/a/' }),
      env,
      ctx,
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('pending');
    expect(ctx.waitUntil).toHaveBeenCalledTimes(1);
  });

  it('returns 400 for invalid contentHash shape', async () => {
    const env = makeEnv();
    const ctx = { waitUntil: jest.fn() };
    const res = await handleExtractPost(
      postExtract({ contentHash: 'short', kind: 'url', url: 'https://x.test/' }),
      env,
      ctx,
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 for missing url with kind=url', async () => {
    const env = makeEnv();
    const ctx = { waitUntil: jest.fn() };
    const res = await handleExtractPost(postExtract({ contentHash: HASH, kind: 'url' }), env, ctx);
    expect(res.status).toBe(400);
  });

  it('returns 405 for non-POST method', async () => {
    const env = makeEnv();
    const ctx = { waitUntil: jest.fn() };
    const req = new Request('https://proxy.example.com/extract', {
      method: 'GET',
      headers: { 'X-RC-User-Id': VALID_ID },
    });
    const res = await handleExtractPost(req, env, ctx);
    expect(res.status).toBe(405);
  });

  it('returns 400 when content-type is not application/json', async () => {
    const env = makeEnv();
    const ctx = { waitUntil: jest.fn() };
    const req = new Request('https://proxy.example.com/extract', {
      method: 'POST',
      headers: { 'content-type': 'text/plain', 'X-RC-User-Id': VALID_ID },
      body: 'hi',
    });
    const res = await handleExtractPost(req, env, ctx);
    expect(res.status).toBe(400);
  });

  it('returns 400 when body is not parseable JSON', async () => {
    const env = makeEnv();
    const ctx = { waitUntil: jest.fn() };
    const req = new Request('https://proxy.example.com/extract', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-RC-User-Id': VALID_ID },
      body: 'not json',
    });
    const res = await handleExtractPost(req, env, ctx);
    expect(res.status).toBe(400);
  });

  it('returns 401 when X-RC-User-Id header is absent', async () => {
    const env = makeEnv();
    const ctx = { waitUntil: jest.fn() };
    const req = new Request('https://proxy.example.com/extract', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contentHash: HASH, kind: 'url', url: 'https://x.test/' }),
    });
    const res = await handleExtractPost(req, env, ctx);
    expect(res.status).toBe(401);
  });

  it('returns 429 when rate-limit denies', async () => {
    const env = makeEnv();
    env.RATE_LIMIT = {
      limit: async () => ({ success: false }),
    } as Env['RATE_LIMIT'];
    const ctx = { waitUntil: jest.fn() };
    const res = await handleExtractPost(
      postExtract({
        contentHash: HASH,
        kind: 'url',
        url: 'https://www.instagram.com/reel/a/',
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('60');
  });

  it('rate-limit binding is keyed by CF-Connecting-IP', async () => {
    const limit = jest.fn(async () => ({ success: true }));
    const env = makeEnv();
    env.RATE_LIMIT = { limit } as unknown as Env['RATE_LIMIT'];
    const ctx = { waitUntil: jest.fn() };
    await handleExtractPost(
      postExtract({
        contentHash: HASH,
        kind: 'url',
        url: 'https://www.instagram.com/reel/a/',
      }),
      env,
      ctx,
    );
    expect(limit).toHaveBeenCalledWith({ key: '1.2.3.4' });
  });
});

describe('handleExtractGet', () => {
  let restore: () => void;
  beforeEach(() => {
    restore = setupCachesAndRcStub();
  });
  afterEach(() => restore());

  it('returns 404 missing when KV has nothing', async () => {
    const env = makeEnv();
    const res = await handleExtractGet(getExtract(HASH), env);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('missing');
  });

  it('returns the cached state when KV has a row', async () => {
    const kv = makeKv();
    kv.store.set(
      `state:${HASH}`,
      JSON.stringify({
        contentHash: HASH,
        status: 'done',
        places: [],
        model: 'cached',
      }),
    );
    const env = makeEnv(kv);
    const res = await handleExtractGet(getExtract(HASH), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('done');
  });

  it('returns 400 for malformed hash in path', async () => {
    const env = makeEnv();
    const req = new Request('https://proxy.example.com/extract/short', {
      method: 'GET',
      headers: { 'X-RC-User-Id': VALID_ID },
    });
    const res = await handleExtractGet(req, env);
    expect(res.status).toBe(400);
  });

  it('returns 405 for non-GET method', async () => {
    const env = makeEnv();
    const req = new Request(`https://proxy.example.com/extract/${HASH}`, {
      method: 'POST',
      headers: { 'X-RC-User-Id': VALID_ID },
    });
    const res = await handleExtractGet(req, env);
    expect(res.status).toBe(405);
  });

  it('returns 401 when X-RC-User-Id header is absent', async () => {
    const env = makeEnv();
    const req = new Request(`https://proxy.example.com/extract/${HASH}`, {
      method: 'GET',
    });
    const res = await handleExtractGet(req, env);
    expect(res.status).toBe(401);
  });
});
