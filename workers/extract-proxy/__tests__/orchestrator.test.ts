import { orchestrate, EXTRACT_STATE_TTL_SECONDS, STALE_PENDING_MS } from '../src/orchestrator';
import type { OrchestratorRequest, OrchestratorState } from '../src/orchestrator-schema';
import type { FetchPostResponse } from '../src/fetch-post';
import type { Env } from '../src/index';

const HASH = 'a'.repeat(64);

function makeKv() {
  const store = new Map<string, string>();
  const ttls = new Map<string, number>();
  return {
    store,
    ttls,
    async put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void> {
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

  it('skips video mode for TikTok even when videoUrl is present', async () => {
    // TikTok's CDN blocks Cloudflare Workers' egress IPs, so the video
    // fetch is a guaranteed-fail roundtrip. The orchestrator should jump
    // straight to vision (cover + caption) and never attempt mode='video'.
    const env = makeEnv();
    let observedMode: string | null = null;
    let videoCalled = false;
    await orchestrate(
      { contentHash: HASH, kind: 'url', url: 'https://www.tiktok.com/@u/video/123' },
      env,
      noopCtx,
      {
        runFetchPost: async () => ({
          result: makeFetched({
            platform: 'tiktok',
            permalink: 'https://www.tiktok.com/@u/video/123',
            videoUrl: 'https://tiktokcdn/v.mp4',
            videoDuration: 12,
            imageUrls: ['https://cdn/cover.jpg'],
          }),
          cacheKind: 'og',
        }),
        runExtract: async (body) => {
          if (body.mode === 'video') videoCalled = true;
          observedMode = body.mode;
          return { places: [], model: 'm' };
        },
        fetchImageBase64: async () => 'b64',
      },
    );
    expect(videoCalled).toBe(false);
    expect(observedMode).toBe('vision');
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
    let observedImage: string | string[] | null = null;
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
    expect(observedImage).toEqual(['b64data']);
  });

  it('sends every carousel slide to runExtract in vision mode', async () => {
    const env = makeEnv();
    let observedImages: string[] | null = null;
    const fetchCalls: string[] = [];
    await orchestrate(
      { contentHash: HASH, kind: 'url', url: 'https://www.instagram.com/p/z/' },
      env,
      noopCtx,
      {
        runFetchPost: async () => ({
          result: makeFetched({
            imageUrls: ['https://cdn/c1.jpg', 'https://cdn/c2.jpg', 'https://cdn/c3.jpg'],
          }),
          cacheKind: 'apify',
        }),
        runExtract: async (body) => {
          if (body.mode === 'vision') observedImages = body.imageBase64;
          return { places: [], model: 'm' };
        },
        fetchImageBase64: async (u) => {
          fetchCalls.push(u);
          return `b64:${u.split('/').pop()}`;
        },
      },
    );
    expect(fetchCalls).toEqual(['https://cdn/c1.jpg', 'https://cdn/c2.jpg', 'https://cdn/c3.jpg']);
    expect(observedImages).toEqual(['b64:c1.jpg', 'b64:c2.jpg', 'b64:c3.jpg']);
  });

  it('tolerates per-slide fetch failures and forwards the survivors', async () => {
    const env = makeEnv();
    let observedImages: string[] | null = null;
    await orchestrate(
      { contentHash: HASH, kind: 'url', url: 'https://www.instagram.com/p/z/' },
      env,
      noopCtx,
      {
        runFetchPost: async () => ({
          result: makeFetched({
            imageUrls: ['https://cdn/c1.jpg', 'https://cdn/c2.jpg', 'https://cdn/c3.jpg'],
          }),
          cacheKind: 'apify',
        }),
        runExtract: async (body) => {
          if (body.mode === 'vision') observedImages = body.imageBase64;
          return { places: [], model: 'm' };
        },
        fetchImageBase64: async (u) => {
          if (u.endsWith('c2.jpg')) throw new Error('image-fetch-403');
          return `b64:${u.split('/').pop()}`;
        },
      },
    );
    expect(observedImages).toEqual(['b64:c1.jpg', 'b64:c3.jpg']);
  });

  it('falls back to text mode when every carousel slide fetch fails', async () => {
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
            imageUrls: ['https://cdn/c1.jpg', 'https://cdn/c2.jpg'],
          }),
          cacheKind: 'apify',
        }),
        runExtract: async (body) => {
          observedMode = body.mode;
          return { places: [], model: 'm' };
        },
        fetchImageBase64: async () => {
          throw new Error('image-fetch-403');
        },
      },
    );
    expect(observedMode).toBe('text');
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

describe('orchestrate — enrichment', () => {
  it('runs searchAndDetails per place, dedups by place_id, then one bulk blurb call', async () => {
    const kv = makeKv();
    const env = makeEnv(kv);

    const searchAndDetailsCalls: string[] = [];
    const bulkBlurbCalls: number[] = [];

    await orchestrate(
      { contentHash: HASH, kind: 'url', url: 'https://www.instagram.com/p/z/' },
      env,
      noopCtx,
      {
        runFetchPost: async () => ({
          result: makeFetched({ caption: 'best brunch in SF' }),
          cacheKind: 'og',
        }),
        runExtract: async () => ({
          places: [
            { name: 'Tartine', city: 'SF', address: '', category: 'food', country_code: 'US' },
            // Same Google place_id as above — should be deduped after Places lookup.
            {
              name: 'Tartine Bakery SF',
              city: 'SF',
              address: '',
              category: 'food',
              country_code: 'US',
            },
            // Distinct place — should survive.
            { name: 'Mister Jius', city: 'SF', address: '', category: 'food', country_code: 'US' },
          ],
          model: 'gemini-test',
        }),
        fetchImageBase64: async () => 'b64',
        searchAndDetails: async (req) => {
          searchAndDetailsCalls.push(req.name);
          if (req.name === 'Mister Jius') {
            return {
              id: 'place-mr-jius',
              displayName: 'Mister Jius',
              formattedAddress: '28 Waverly Pl',
              photoName: 'places/place-mr-jius/photos/X',
              rating: 4.5,
              priceLevel: 3,
              googleMapsUri: 'https://maps.example/mr-jius',
              latitude: 37.79,
              longitude: -122.41,
              types: ['restaurant'],
              editorialSummary: 'Modern Chinese.',
              city: 'San Francisco',
              countryCode: 'US',
            };
          }
          // Both "Tartine" and "Tartine Bakery SF" → same place_id.
          return {
            id: 'place-tartine',
            displayName: 'Tartine Bakery',
            formattedAddress: '600 Guerrero St',
            photoName: 'places/place-tartine/photos/Y',
            rating: 4.6,
            priceLevel: 2,
            googleMapsUri: 'https://maps.example/tartine',
            latitude: 37.76,
            longitude: -122.42,
            types: ['bakery'],
            editorialSummary: null,
            city: 'San Francisco',
            countryCode: 'US',
          };
        },
        buildBulkBlurb: async (items) => {
          bulkBlurbCalls.push(items.length);
          const out = new Map();
          for (const it of items) {
            out.set(it.id, { text: `Blurb for ${it.name}.`, outcome: 'ok' });
          }
          return out;
        },
      },
    );

    const final = captureState(kv)!;
    expect(final.status).toBe('done');
    // All three places hit Places (parallel) but only the two distinct
    // place_ids survive after dedup.
    expect(searchAndDetailsCalls).toHaveLength(3);
    expect(final.places).toHaveLength(2);
    // One bulk blurb call for the two survivors.
    expect(bulkBlurbCalls).toEqual([2]);

    const tartine = final.places!.find((p) => p.name === 'Tartine');
    expect(tartine).toMatchObject({
      external_place_id: 'place-tartine',
      formatted_address: '600 Guerrero St',
      photo_name: 'places/place-tartine/photos/Y',
      blurb: 'Blurb for Tartine.',
      blurb_status: 'ok',
    });

    const mrJius = final.places!.find((p) => p.name === 'Mister Jius');
    expect(mrJius?.external_place_id).toBe('place-mr-jius');
  });

  it('marks blurb_status=failed when bulk blurb returns no entry for a place', async () => {
    const kv = makeKv();
    const env = makeEnv(kv);
    await orchestrate(
      { contentHash: HASH, kind: 'url', url: 'https://www.instagram.com/p/z/' },
      env,
      noopCtx,
      {
        runFetchPost: async () => ({
          result: makeFetched({ caption: 'cap' }),
          cacheKind: 'og',
        }),
        runExtract: async () => ({
          places: [{ name: 'X', city: 'SF', address: '', category: 'food', country_code: 'US' }],
          model: 'gemini-test',
        }),
        fetchImageBase64: async () => 'b64',
        searchAndDetails: async () => ({
          id: 'place-x',
          displayName: 'X',
          formattedAddress: '1 X St',
          photoName: null,
          rating: null,
          priceLevel: null,
          googleMapsUri: null,
          latitude: null,
          longitude: null,
          types: [],
          editorialSummary: null,
          city: 'SF',
          countryCode: 'US',
        }),
        // Empty map — simulates the bulk call returning nothing usable.
        buildBulkBlurb: async () => new Map(),
      },
    );
    const final = captureState(kv)!;
    expect(final.places).toHaveLength(1);
    expect(final.places![0]).toMatchObject({
      external_place_id: 'place-x',
      blurb: null,
      blurb_status: 'failed',
    });
  });

  it('keeps a place with blurb_status=not-found when Google Places returns null', async () => {
    const kv = makeKv();
    const env = makeEnv(kv);
    await orchestrate(
      { contentHash: HASH, kind: 'url', url: 'https://www.instagram.com/p/z/' },
      env,
      noopCtx,
      {
        runFetchPost: async () => ({
          result: makeFetched({ caption: 'cap' }),
          cacheKind: 'og',
        }),
        runExtract: async () => ({
          places: [
            {
              name: 'Imaginary Spot',
              city: 'Nowhere',
              address: '',
              category: 'food',
              country_code: '',
            },
          ],
          model: 'gemini-test',
        }),
        fetchImageBase64: async () => 'b64',
        searchAndDetails: async () => null,
        buildBulkBlurb: async () => new Map(),
      },
    );
    const final = captureState(kv)!;
    expect(final.places).toHaveLength(1);
    expect(final.places![0]).toMatchObject({
      name: 'Imaginary Spot',
      blurb: null,
      blurb_status: 'not-found',
    });
    // No external_place_id when Google didn't match.
    expect(final.places![0]?.external_place_id).toBeUndefined();
  });
});

describe('EXTRACT_STATE_TTL_SECONDS', () => {
  it('is 72 hours', () => {
    expect(EXTRACT_STATE_TTL_SECONDS).toBe(72 * 60 * 60);
  });
});
