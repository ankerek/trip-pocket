import {
  orchestrate,
  EXTRACT_STATE_TTL_SECONDS,
  STALE_PENDING_MS,
} from '../src/orchestrator';
import type {
  OrchestratorRequest,
  OrchestratorState,
} from '../src/orchestrator-schema';
import type { FetchPostResponse } from '../src/fetch-post';
import type { Env } from '../src/index';

const HASH = 'a'.repeat(64);

function makeKv() {
  const store = new Map<string, string>();
  const ttls = new Map<string, number>();
  return {
    store,
    ttls,
    async put(
      key: string,
      value: string,
      opts?: { expirationTtl?: number },
    ): Promise<void> {
      store.set(key, value);
      if (opts?.expirationTtl != null) ttls.set(key, opts.expirationTtl);
    },
    async get(key: string): Promise<string | null> {
      return store.get(key) ?? null;
    },
  };
}

function captureState(kv: ReturnType<typeof makeKv>): OrchestratorState | null {
  const raw = kv.store.get(`state:${HASH}`);
  return raw ? (JSON.parse(raw) as OrchestratorState) : null;
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
  };
}

const noopCtx = { waitUntil: () => {} };

const makeFetched = (overrides: Partial<FetchPostResponse> = {}): FetchPostResponse => ({
  platform: 'instagram',
  permalink: 'https://www.instagram.com/reel/x/',
  caption: 'A great place',
  imageUrls: ['https://cdn.example/cover.jpg'],
  author: '@x',
  ...overrides,
});

describe('orchestrate', () => {
  it('writes pending then partial then done for a video URL', async () => {
    const kv = makeKv();
    const env = makeEnv(kv);
    const req: OrchestratorRequest = {
      contentHash: HASH,
      kind: 'url',
      url: 'https://www.instagram.com/reel/abc/',
    };
    const observedStatuses: string[] = [];
    await orchestrate(req, env, noopCtx, {
      runFetchPost: async () => {
        observedStatuses.push(captureState(kv)!.status);
        return {
          result: makeFetched({
            videoUrl: 'https://cdn.example/v.mp4',
            videoDuration: 12,
          }),
          cacheKind: 'apify',
        };
      },
      runExtract: async () => {
        observedStatuses.push(captureState(kv)!.status);
        return {
          places: [
            {
              name: 'Tartine',
              city: 'SF',
              address: '',
              category: 'food',
              country_code: 'US',
            },
            {
              name: 'tartine',
              city: 'SF',
              address: '',
              category: 'food',
              country_code: 'US',
            },
          ],
          model: 'gemini-test',
        };
      },
    });

    expect(observedStatuses).toEqual(['pending', 'partial']);
    const final = captureState(kv)!;
    expect(final.status).toBe('done');
    expect(final.places).toHaveLength(1); // dedupe collapsed the duplicate
    expect(final.caption).toBe('A great place');
    expect(final.coverUrl).toBe('https://cdn.example/cover.jpg');
    expect(final.model).toBe('gemini-test');
    expect(final.videoPresent).toBe(true);
  });

  it('writes error state when runFetchPost throws', async () => {
    const kv = makeKv();
    const env = makeEnv(kv);
    await orchestrate(
      { contentHash: HASH, kind: 'url', url: 'https://www.instagram.com/reel/x/' },
      env,
      noopCtx,
      {
        runFetchPost: async () => {
          throw new Error('boom');
        },
        runExtract: async () => {
          throw new Error('should not be called');
        },
      },
    );
    const final = captureState(kv)!;
    expect(final.status).toBe('error');
    expect(final.error).toBe('fetch-failed');
  });

  it('writes error state when runExtract throws', async () => {
    const kv = makeKv();
    const env = makeEnv(kv);
    await orchestrate(
      { contentHash: HASH, kind: 'url', url: 'https://www.instagram.com/p/x/' },
      env,
      noopCtx,
      {
        runFetchPost: async () => ({
          result: makeFetched({ caption: 'cap' }),
          cacheKind: 'og',
        }),
        runExtract: async () => {
          throw new Error('gemini-rage');
        },
        fetchImageBase64: async () => 'b64',
      },
    );
    const final = captureState(kv)!;
    expect(final.status).toBe('error');
    expect(final.error).toBe('extract-failed');
  });

  it('chooses video mode when fetch returns videoUrl', async () => {
    const env = makeEnv();
    let observedMode: string | null = null;
    await orchestrate(
      { contentHash: HASH, kind: 'url', url: 'https://www.instagram.com/reel/y/' },
      env,
      noopCtx,
      {
        runFetchPost: async () => ({
          result: makeFetched({
            videoUrl: 'https://cdn/v.mp4',
            videoDuration: 12,
          }),
          cacheKind: 'apify',
        }),
        runExtract: async (body) => {
          observedMode = body.mode;
          return { places: [], model: 'm' };
        },
      },
    );
    expect(observedMode).toBe('video');
  });

  it('chooses vision mode when no video but cover present', async () => {
    const env = makeEnv();
    let observedMode: string | null = null;
    let observedImage: string | null = null;
    await orchestrate(
      { contentHash: HASH, kind: 'url', url: 'https://www.instagram.com/p/z/' },
      env,
      noopCtx,
      {
        runFetchPost: async () => ({
          result: makeFetched({ imageUrls: ['https://cdn/c.jpg'] }),
          cacheKind: 'og',
        }),
        runExtract: async (body) => {
          observedMode = body.mode;
          if (body.mode === 'vision') observedImage = body.imageBase64;
          return { places: [], model: 'm' };
        },
        fetchImageBase64: async () => 'b64data',
      },
    );
    expect(observedMode).toBe('vision');
    expect(observedImage).toBe('b64data');
  });

  it('chooses text mode when no video and no cover but caption present', async () => {
    const env = makeEnv();
    let observedMode: string | null = null;
    await orchestrate(
      { contentHash: HASH, kind: 'url', url: 'https://www.instagram.com/p/z/' },
      env,
      noopCtx,
      {
        runFetchPost: async () => ({
          result: makeFetched({
            caption: 'a long caption naming places',
            imageUrls: [],
          }),
          cacheKind: 'og',
        }),
        runExtract: async (body) => {
          observedMode = body.mode;
          return { places: [], model: 'm' };
        },
      },
    );
    expect(observedMode).toBe('text');
  });

  it('writes error when no extractable content is available', async () => {
    const kv = makeKv();
    const env = makeEnv(kv);
    await orchestrate(
      { contentHash: HASH, kind: 'url', url: 'https://www.instagram.com/p/z/' },
      env,
      noopCtx,
      {
        runFetchPost: async () => ({
          result: makeFetched({ caption: '', imageUrls: [] }),
          cacheKind: 'og',
        }),
        runExtract: async () => {
          throw new Error('should not be called');
        },
      },
    );
    expect(captureState(kv)!.status).toBe('error');
    expect(captureState(kv)!.error).toBe('no-extractable-content');
  });

  it('returns cached done state without calling runFetchPost or runExtract', async () => {
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
    const calls = { fetch: 0, extract: 0 };
    await orchestrate(
      { contentHash: HASH, kind: 'url', url: 'https://www.instagram.com/reel/a/' },
      env,
      noopCtx,
      {
        runFetchPost: async () => {
          calls.fetch++;
          throw new Error('nope');
        },
        runExtract: async () => {
          calls.extract++;
          throw new Error('nope');
        },
      },
    );
    expect(calls).toEqual({ fetch: 0, extract: 0 });
    expect(captureState(kv)!.model).toBe('cached');
  });

  it('skips an in-flight pending state that is younger than STALE_PENDING_MS', async () => {
    const kv = makeKv();
    kv.store.set(
      `state:${HASH}`,
      JSON.stringify({
        contentHash: HASH,
        status: 'pending',
        startedAt: new Date().toISOString(),
      }),
    );
    const env = makeEnv(kv);
    const calls = { fetch: 0 };
    await orchestrate(
      { contentHash: HASH, kind: 'url', url: 'https://www.instagram.com/reel/a/' },
      env,
      noopCtx,
      {
        runFetchPost: async () => {
          calls.fetch++;
          return { result: makeFetched(), cacheKind: 'og' };
        },
        runExtract: async () => ({ places: [], model: 'm' }),
      },
    );
    expect(calls.fetch).toBe(0);
  });

  it('re-runs when an existing pending state is older than STALE_PENDING_MS', async () => {
    const kv = makeKv();
    kv.store.set(
      `state:${HASH}`,
      JSON.stringify({
        contentHash: HASH,
        status: 'pending',
        startedAt: new Date(Date.now() - 2 * STALE_PENDING_MS).toISOString(),
      }),
    );
    const env = makeEnv(kv);
    const calls = { fetch: 0 };
    await orchestrate(
      { contentHash: HASH, kind: 'url', url: 'https://www.instagram.com/reel/a/' },
      env,
      noopCtx,
      {
        runFetchPost: async () => {
          calls.fetch++;
          return { result: makeFetched(), cacheKind: 'og' };
        },
        runExtract: async () => ({ places: [], model: 'm' }),
      },
    );
    expect(calls.fetch).toBe(1);
  });

  it('writes states with a 72h TTL on KV put', async () => {
    const kv = makeKv();
    const env = makeEnv(kv);
    await orchestrate(
      { contentHash: HASH, kind: 'url', url: 'https://www.instagram.com/p/z/' },
      env,
      noopCtx,
      {
        runFetchPost: async () => ({
          result: makeFetched({ caption: 'cap', imageUrls: [] }),
          cacheKind: 'og',
        }),
        runExtract: async () => ({ places: [], model: 'm' }),
      },
    );
    expect(kv.ttls.get(`state:${HASH}`)).toBe(EXTRACT_STATE_TTL_SECONDS);
  });
});

describe('EXTRACT_STATE_TTL_SECONDS', () => {
  it('is 72 hours', () => {
    expect(EXTRACT_STATE_TTL_SECONDS).toBe(72 * 60 * 60);
  });
});
