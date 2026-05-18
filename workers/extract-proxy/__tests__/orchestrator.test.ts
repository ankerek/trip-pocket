import {
  orchestrate,
  routeStage,
  EXTRACT_STATE_TTL_SECONDS,
  STALE_PENDING_MS,
} from '../src/orchestrator';
import type {
  ExtractJobMessage,
  OrchestratorRequest,
  OrchestratorState,
} from '../src/orchestrator-schema';
import { TransientFetchError } from '../src/fetch-post';
import type { FetchPostResponse } from '../src/fetch-post';
import { RunExtractError } from '../src/index';
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

  it('writes done with blurb_status=failed for every enriched place (bulk-blurb is deferred)', async () => {
    // Bulk-blurb runs in the client's per-place /blurb-retry path now —
    // it doesn't fit inside Cloudflare's 30s ctx.waitUntil cap when a
    // big carousel already used 25-28s on fetch-post + vision + enrich.
    // The deferred-blurb design writes `done` immediately with every
    // place marked failed; the client backfills lazily.
    const kv = makeKv();
    const env = makeEnv(kv);
    let bulkBlurbCalled = false;
    await orchestrate(
      { contentHash: HASH, kind: 'url', url: 'https://www.instagram.com/p/x/' },
      env,
      noopCtx,
      {
        runFetchPost: async () => ({
          result: makeFetched({ caption: 'cap', imageUrls: ['https://cdn/c.jpg'] }),
          cacheKind: 'apify',
        }),
        runExtract: async () => ({
          places: [{ name: 'A', city: 'B', address: '', category: 'food', country_code: '' }],
          model: 'm',
        }),
        fetchImageBase64: async () => 'b64',
        searchAndDetails: async () => ({
          id: 'place_A',
          latitude: 1,
          longitude: 2,
          formattedAddress: 'addr',
          photoName: null,
          rating: null,
          priceLevel: null,
          googleMapsUri: null,
          displayName: 'A',
          types: [],
          editorialSummary: null,
          city: 'B',
          countryCode: 'JP',
        }),
        buildBulkBlurb: async () => {
          bulkBlurbCalled = true;
          return new Map();
        },
      },
    );

    expect(bulkBlurbCalled).toBe(false);
    const final = captureState(kv)!;
    expect(final.status).toBe('done');
    expect(final.places).toHaveLength(1);
    expect(final.places![0]!.blurb).toBeNull();
    expect(final.places![0]!.blurb_status).toBe('failed');
    // Enrichment fields preserved — client only re-runs the blurb step,
    // not the Google Places resolution.
    expect(final.places![0]!.external_place_id).toBe('place_A');
  });

  it('keeps the early un-enriched `done` when enrichment throws (e.g. Too many subrequests)', async () => {
    // Real-world repro: 8-slide IG carousel extracts 20 places, then the
    // parallel Google Places fan-out tips the Worker over the 50/1000
    // subrequest cap and Promise.all throws. We must NOT downgrade the
    // safety-net `done` (written right after extract, with un-enriched
    // places) to `error` — the source is already unstuck with usable
    // places, and the client's lazy enricher will fill in the missing
    // Google Places fields on its own schedule. Downgrading to error
    // would surface a misleading "failed import" to the user.
    const kv = makeKv();
    const env = makeEnv(kv);
    await orchestrate(
      { contentHash: HASH, kind: 'url', url: 'https://www.instagram.com/p/x/' },
      env,
      noopCtx,
      {
        runFetchPost: async () => ({
          result: makeFetched({ caption: 'cap', imageUrls: ['https://cdn/c.jpg'] }),
          cacheKind: 'apify',
        }),
        runExtract: async () => ({
          places: [
            { name: 'A', city: 'B', address: '', category: 'food', country_code: '' },
            { name: 'C', city: 'D', address: '', category: 'food', country_code: '' },
          ],
          model: 'm',
        }),
        fetchImageBase64: async () => 'b64',
        searchAndDetails: async () => {
          throw new Error('Too many subrequests by single Worker invocation');
        },
      },
    );
    const final = captureState(kv)!;
    expect(final.status).toBe('done');
    // Un-enriched payload: places came from extract, but blurb_status is
    // 'failed' and there's no external_place_id. The client inserts these
    // with enrichment_status='pending' and runs its lazy enricher.
    expect(final.places).toHaveLength(2);
    expect(final.places![0]!.blurb_status).toBe('failed');
    expect(final.places![0]!.external_place_id).toBeUndefined();
    expect(final.caption).toBe('cap');
    expect(final.coverUrl).toBe('https://cdn/c.jpg');
  });

  it('writes an early un-enriched `done` BEFORE Google Places is called', async () => {
    // Safety net for the ctx.waitUntil 30s cap. After a successful extract
    // the orchestrator writes a `done` with un-enriched places (so the
    // source unsticks immediately) and ONLY THEN starts the per-place
    // Google Places fan-out. If the runtime kills the isolate mid-enrich,
    // the user already has usable places — the client's lazy enricher
    // backfills the rest.
    const kv = makeKv();
    const env = makeEnv(kv);
    // Snapshot KV state at the moment searchAndDetails is first invoked.
    let stateAtEnrichStart: OrchestratorState | null = null;
    await orchestrate(
      { contentHash: HASH, kind: 'url', url: 'https://www.instagram.com/p/x/' },
      env,
      noopCtx,
      {
        runFetchPost: async () => ({
          result: makeFetched({ caption: 'cap', imageUrls: ['https://cdn/c.jpg'] }),
          cacheKind: 'apify',
        }),
        runExtract: async () => ({
          places: [{ name: 'A', city: 'B', address: '', category: 'food', country_code: '' }],
          model: 'm',
        }),
        fetchImageBase64: async () => 'b64',
        searchAndDetails: async () => {
          if (stateAtEnrichStart === null) stateAtEnrichStart = captureState(kv);
          return {
            id: 'place_A',
            latitude: 1,
            longitude: 2,
            formattedAddress: 'addr',
            photoName: null,
            rating: null,
            priceLevel: null,
            googleMapsUri: null,
            displayName: 'A',
            types: [],
            editorialSummary: null,
            city: 'B',
            countryCode: 'US',
          };
        },
      },
    );

    // KV at the moment Google Places started: status='done', places present,
    // but un-enriched (no external_place_id, blurb_status='failed').
    expect(stateAtEnrichStart).not.toBeNull();
    expect(stateAtEnrichStart!.status).toBe('done');
    expect(stateAtEnrichStart!.places).toHaveLength(1);
    expect(stateAtEnrichStart!.places![0]!.external_place_id).toBeUndefined();
    expect(stateAtEnrichStart!.places![0]!.blurb_status).toBe('failed');

    // After enrichment completes, KV upgraded to the fully-enriched payload.
    const final = captureState(kv)!;
    expect(final.status).toBe('done');
    expect(final.places![0]!.external_place_id).toBe('place_A');
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

  it('leaves state at partial (no error write) when every mode fails transient (5xx)', async () => {
    // Real-world repro: Gemini returns 503 "model is currently experiencing
    // high demand" on both vision AND text fallback. Both are transient.
    // Orchestrator must NOT overwrite the partial state with terminal
    // `error`, so the next foreground sweep's stale-pending recovery can
    // retrigger orchestration without manual intervention.
    const kv = makeKv();
    const env = makeEnv(kv);
    await orchestrate(
      { contentHash: HASH, kind: 'url', url: 'https://www.instagram.com/p/z/' },
      env,
      noopCtx,
      {
        runFetchPost: async () => ({
          result: makeFetched({ caption: 'cap', imageUrls: ['https://cdn/c.jpg'] }),
          cacheKind: 'apify',
        }),
        runExtract: async () => {
          throw new RunExtractError('upstream-error', 502);
        },
        fetchImageBase64: async () => 'b64',
      },
    );
    const state = captureState(kv);
    expect(state).not.toBeNull();
    expect(state!.status).toBe('partial');
    expect(state!.caption).toBe('cap');
    // Existing partial fields preserved — caller can still render the
    // triage card while waiting for the retry.
    expect(state!.coverUrl).toBe('https://cdn/c.jpg');
  });

  it('writes terminal error when any mode fails permanently (e.g. schema violation)', async () => {
    // Schema violations / bad-shape from Gemini are deterministic — the
    // same payload yields the same malformed response, retrying won't
    // help. A single permanent failure across the fallback chain flips
    // the run terminal so the user sees "failed" rather than spinning.
    const kv = makeKv();
    const env = makeEnv(kv);
    let call = 0;
    await orchestrate(
      { contentHash: HASH, kind: 'url', url: 'https://www.instagram.com/p/z/' },
      env,
      noopCtx,
      {
        runFetchPost: async () => ({
          result: makeFetched({ caption: 'cap', imageUrls: ['https://cdn/c.jpg'] }),
          cacheKind: 'apify',
        }),
        runExtract: async () => {
          call++;
          // First call (vision) → transient. Second call (text fallback)
          // → permanent (schema violation). Mixed → terminal error.
          if (call === 1) throw new RunExtractError('upstream-error', 502);
          throw new RunExtractError('upstream-schema-violation', 502);
        },
        fetchImageBase64: async () => 'b64',
      },
    );
    const state = captureState(kv);
    expect(state!.status).toBe('error');
    expect(state!.error).toBe('extract-failed');
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
  it('runs searchAndDetails per place, dedups by place_id, defers blurbs to client retry', async () => {
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
    // Bulk-blurb deliberately skipped — see orchestrator.ts comment near
    // the `blurb_deferred` log event. Client backfills via /enrich.
    expect(bulkBlurbCalls).toEqual([]);

    const tartine = final.places!.find((p) => p.name === 'Tartine');
    expect(tartine).toMatchObject({
      external_place_id: 'place-tartine',
      formatted_address: '600 Guerrero St',
      photo_name: 'places/place-tartine/photos/Y',
      blurb: null,
      blurb_status: 'failed',
    });

    const mrJius = final.places!.find((p) => p.name === 'Mister Jius');
    expect(mrJius?.external_place_id).toBe('place-mr-jius');
    expect(mrJius?.blurb_status).toBe('failed');
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

// ---------------------------------------------------------------------------
// Stage-level edge cases driven through `routeStage` directly. The
// orchestrate() tests above exercise the happy path / failure path with all
// three stages running in-process via the sync stub queue. These tests cover
// the cross-invocation / queue-redelivery scenarios that the sync helper
// can't reach: a stage receiving a message for a hash whose KV state is
// missing, stale, or already past the stage's work.
// ---------------------------------------------------------------------------

/**
 * No-op queue stub for stage-level tests that don't expect any stage to
 * fire `.send()` (i.e. the stage either skips or writes a terminal state).
 * Captures sends so a test can assert nothing was enqueued.
 */
function makeNoopQueue(): {
  queue: Env['EXTRACT_QUEUE'];
  sent: ExtractJobMessage[];
} {
  const sent: ExtractJobMessage[] = [];
  const queue: Env['EXTRACT_QUEUE'] = {
    async send(body: ExtractJobMessage) {
      sent.push(body);
      return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
    },
    async sendBatch() {
      return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
    },
    async metrics() {
      return { backlogCount: 0, backlogBytes: 0 };
    },
  };
  return { queue, sent };
}

function envWithQueue(kv: ReturnType<typeof makeKv>, queue: Env['EXTRACT_QUEUE']): Env {
  return { ...makeEnv(kv), EXTRACT_QUEUE: queue };
}

describe('routeStage — fetch-post stage redelivery', () => {
  it('re-throws TransientFetchError so the queue retries; KV state stays at pending', async () => {
    // Real-world repro: Apify's IG actor ran past its per-run timeout
    // budget on a /reel/ share. The legacy classification of this as a
    // terminal `fetch-failed` row meant the user saw "couldn't read" with
    // no automatic recovery — the only way back was to re-share from
    // Instagram. Treating actor TIMED-OUT as transient lets Cloudflare
    // Queues' retry-with-backoff kick in, which usually succeeds on the
    // next attempt without any user intervention.
    const kv = makeKv();
    const startedAt = new Date().toISOString();
    kv.store.set(
      `state:${HASH}`,
      JSON.stringify({
        contentHash: HASH,
        status: 'pending',
        startedAt,
      } satisfies OrchestratorState),
    );
    const { queue, sent } = makeNoopQueue();
    const env = envWithQueue(kv, queue);

    let runFetchPostCalls = 0;
    await expect(
      routeStage(
        {
          stage: 'fetch-post',
          contentHash: HASH,
          url: 'https://www.instagram.com/reel/x/',
        },
        env,
        noopCtx,
        {
          runFetchPost: async () => {
            runFetchPostCalls++;
            throw new TransientFetchError('apify-timed-out');
          },
        },
      ),
    ).rejects.toBeInstanceOf(TransientFetchError);

    expect(runFetchPostCalls).toBe(1);
    // KV stays at pending — the queue retry will run fetch-post again
    // cleanly. A terminal `error` write here would defeat the whole
    // point: the client would mark the source `failed` and the user
    // would see "COULDN'T READ" before the retry even runs.
    const state = captureState(kv)!;
    expect(state.status).toBe('pending');
    expect(state.startedAt).toBe(startedAt);
    // No downstream stage enqueued.
    expect(sent).toEqual([]);
  });

  it('skips when the prior run already terminated as `done` (idempotent on redelivery)', async () => {
    // The queue can redeliver a message that was already processed before
    // ack reached the runtime (network blip between ack and dispatcher).
    // The fetch-post stage must not redo work or overwrite the terminal
    // `done` row.
    const kv = makeKv();
    kv.store.set(
      `state:${HASH}`,
      JSON.stringify({
        contentHash: HASH,
        status: 'done',
        places: [],
        model: 'cached',
      } satisfies OrchestratorState),
    );
    const { queue, sent } = makeNoopQueue();
    const env = envWithQueue(kv, queue);

    let runFetchPostCalled = false;
    await routeStage(
      {
        stage: 'fetch-post',
        contentHash: HASH,
        url: 'https://www.instagram.com/p/x/',
      },
      env,
      noopCtx,
      {
        runFetchPost: async () => {
          runFetchPostCalled = true;
          return { result: makeFetched(), cacheKind: 'og' };
        },
      },
    );

    expect(runFetchPostCalled).toBe(false);
    expect(sent).toEqual([]);
    // KV unchanged.
    expect(captureState(kv)!.status).toBe('done');
    expect(captureState(kv)!.model).toBe('cached');
  });
});

describe('routeStage — extract stage edge cases', () => {
  it('logs and returns when KV state is missing (TTL expired between stages)', async () => {
    // Edge case: KV's 72h TTL elapsed while the extract message sat in the
    // queue. There's no fetched payload to consume; just return cleanly so
    // the message can ack — re-sharing produces a fresh contentHash + run.
    const kv = makeKv(); // empty
    const { queue, sent } = makeNoopQueue();
    const env = envWithQueue(kv, queue);

    await routeStage({ stage: 'extract', contentHash: HASH }, env, noopCtx);

    expect(captureState(kv)).toBeNull();
    expect(sent).toEqual([]);
  });

  it('skips when state is already terminal (`done` from a prior run)', async () => {
    // Idempotent on redelivery: a re-delivered `extract` message for a
    // contentHash that already completed must not redo work.
    const kv = makeKv();
    kv.store.set(
      `state:${HASH}`,
      JSON.stringify({
        contentHash: HASH,
        status: 'done',
        places: [],
        model: 'cached',
      } satisfies OrchestratorState),
    );
    const { queue, sent } = makeNoopQueue();
    const env = envWithQueue(kv, queue);

    let runExtractCalled = false;
    await routeStage({ stage: 'extract', contentHash: HASH }, env, noopCtx, {
      runExtract: async () => {
        runExtractCalled = true;
        return { places: [], model: 'm' };
      },
    });

    expect(runExtractCalled).toBe(false);
    expect(sent).toEqual([]);
  });

  it('writes `error` (fetched-missing) when state lacks the fetched payload', async () => {
    // Schema-drift defense: an older KV row (pre-queues) may have
    // status=partial without a `fetched` field. Without this guard the
    // stage would crash on `fetched.platform` and the queue would retry
    // forever. Instead, surface as terminal error so the client sees a
    // failed import.
    const kv = makeKv();
    kv.store.set(
      `state:${HASH}`,
      JSON.stringify({
        contentHash: HASH,
        status: 'partial',
        caption: 'cap',
        coverUrl: 'https://cdn/c.jpg',
        videoPresent: false,
        startedAt: new Date().toISOString(),
        // fetched intentionally omitted
      } satisfies OrchestratorState),
    );
    const { queue, sent } = makeNoopQueue();
    const env = envWithQueue(kv, queue);

    await routeStage({ stage: 'extract', contentHash: HASH }, env, noopCtx);

    const final = captureState(kv)!;
    expect(final.status).toBe('error');
    expect(final.error).toBe('fetched-missing');
    expect(sent).toEqual([]);
  });
});

describe('routeStage — enrich stage edge cases', () => {
  it('logs and returns when KV state is missing', async () => {
    const kv = makeKv();
    const { queue, sent } = makeNoopQueue();
    const env = envWithQueue(kv, queue);

    await routeStage({ stage: 'enrich', contentHash: HASH }, env, noopCtx);

    expect(captureState(kv)).toBeNull();
    expect(sent).toEqual([]);
  });

  it('skips when state is `error` (extract stage failed terminally)', async () => {
    const kv = makeKv();
    kv.store.set(
      `state:${HASH}`,
      JSON.stringify({
        contentHash: HASH,
        status: 'error',
        error: 'extract-failed',
      } satisfies OrchestratorState),
    );
    const env = envWithQueue(kv, makeNoopQueue().queue);

    let searchCalled = false;
    await routeStage({ stage: 'enrich', contentHash: HASH }, env, noopCtx, {
      searchAndDetails: async () => {
        searchCalled = true;
        return null;
      },
    });

    expect(searchCalled).toBe(false);
    expect(captureState(kv)!.status).toBe('error');
  });

  it('logs and returns when precondition fails (state is still `partial`, no places)', async () => {
    // Defensive: the extract stage should have left a `done` row with
    // places before enqueueing enrich. If we get here with `partial`, the
    // pipeline is in an unexpected state — log so it shows up in Sentry,
    // but don't blow up.
    const kv = makeKv();
    kv.store.set(
      `state:${HASH}`,
      JSON.stringify({
        contentHash: HASH,
        status: 'partial',
        caption: 'cap',
        startedAt: new Date().toISOString(),
      } satisfies OrchestratorState),
    );
    const env = envWithQueue(kv, makeNoopQueue().queue);

    let searchCalled = false;
    await routeStage({ stage: 'enrich', contentHash: HASH }, env, noopCtx, {
      searchAndDetails: async () => {
        searchCalled = true;
        return null;
      },
    });

    expect(searchCalled).toBe(false);
    expect(captureState(kv)!.status).toBe('partial');
  });

  it('is idempotent on redelivery: skips when places are already enriched', async () => {
    // The most important idempotency guard: a redelivered `enrich` message
    // (e.g. ack lost between worker and runtime) must NOT redo the Google
    // Places fan-out — both for cost reasons (~2 subrequests per place)
    // and to avoid overwriting blurb data with a degraded second run.
    const kv = makeKv();
    kv.store.set(
      `state:${HASH}`,
      JSON.stringify({
        contentHash: HASH,
        status: 'done',
        caption: 'cap',
        places: [
          {
            name: 'A',
            city: 'B',
            address: '',
            category: 'food',
            country_code: '',
            external_place_id: 'place_A',
            blurb_status: 'ok',
            blurb: 'A nice spot',
          },
        ],
        model: 'gemini-test',
      } satisfies OrchestratorState),
    );
    const env = envWithQueue(kv, makeNoopQueue().queue);

    let searchCalled = false;
    await routeStage({ stage: 'enrich', contentHash: HASH }, env, noopCtx, {
      searchAndDetails: async () => {
        searchCalled = true;
        return null;
      },
    });

    expect(searchCalled).toBe(false);
    // KV unchanged.
    const final = captureState(kv)!;
    expect(final.places![0]!.external_place_id).toBe('place_A');
    expect(final.places![0]!.blurb).toBe('A nice spot');
  });
});
