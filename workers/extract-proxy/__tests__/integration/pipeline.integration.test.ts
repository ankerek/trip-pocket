// End-to-end worker integration tests.
//
// Each scenario drives the full pipeline via `handleExtractPost` →
// `orchestrate()` → `handleExtractGet`, with every outbound HTTP call
// stubbed via `network-mock`. The orchestrator, fetcher chain,
// `runFetchPost`, `runExtract` fallback ladder, KV state machine,
// dedupe, enrichment, and bulk-blurb fan-out all run un-mocked — only
// the network seam is faked, so cross-stage bugs surface here in a way
// the per-module unit tests miss.

import { handleExtractGet, handleExtractPost } from '../../src/index';
import type { OrchestratorState } from '../../src/orchestrator-schema';
import {
  createNetworkMock,
  installCachesPolyfill,
  makeAwaitableCtx,
  rcActiveHandler,
  VALID_RC_USER_ID,
} from './network-mock';
import {
  apifyResponse,
  efgFor,
  geminiBlurbResponse,
  geminiDispatcher,
  geminiExtractResponse,
  GEMINI_GATEWAY_PREFIX,
  HASH,
  igPostHtml,
  imageResponse,
  makeEnv,
  placesDetailsResponse,
  placesSearchResponse,
  tiktokNoRehydrationHtml,
  tiktokOembedResponse,
  tiktokPhotoHtml,
  tiktokVideoHtml,
} from './helpers';

function postExtract(body: unknown): Request {
  return new Request('https://proxy.example.com/extract', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'CF-Connecting-IP': '1.2.3.4',
      'X-RC-User-Id': VALID_RC_USER_ID,
    },
    body: JSON.stringify(body),
  });
}

function getExtract(hash: string): Request {
  return new Request(`https://proxy.example.com/extract/${hash}`, {
    method: 'GET',
    headers: { 'X-RC-User-Id': VALID_RC_USER_ID },
  });
}

async function readGet(
  hash: string,
  env: Parameters<typeof handleExtractGet>[1],
): Promise<{
  status: number;
  body: OrchestratorState & { status: string };
}> {
  const resp = await handleExtractGet(getExtract(hash), env);
  const body = (await resp.json()) as OrchestratorState & { status: string };
  return { status: resp.status, body };
}

describe('extract-proxy pipeline integration', () => {
  let restoreCaches: () => void;
  let restoreFetch: (() => void) | null = null;

  beforeEach(() => {
    restoreCaches = installCachesPolyfill();
  });
  afterEach(() => {
    if (restoreFetch) restoreFetch();
    restoreFetch = null;
    restoreCaches();
  });

  // ----- Scenario 1: IG /p/ single-image, og fast path, vision mode ---------

  it('IG single-image post: og fast path → vision → enrich → done', async () => {
    const url = 'https://www.instagram.com/p/ABC123/';
    const coverUrl = `https://cdn.example/cover.jpg?efg=${efgFor('GraphImage')}`;

    const mock = createNetworkMock()
      .on('https://api.revenuecat.com/v1/subscribers/', rcActiveHandler())
      .on(
        'https://www.instagram.com/p/',
        () => new Response(igPostHtml({ coverUrl, caption: 'Best tonkatsu in Tokyo' })),
      )
      .on('https://cdn.example/', () => imageResponse())
      .on(
        GEMINI_GATEWAY_PREFIX,
        geminiDispatcher({
          extract: () =>
            new Response(
              JSON.stringify(
                geminiExtractResponse([
                  {
                    name: 'Maru Tonkatsu',
                    city: 'Tokyo',
                    address: '1-2-3 Shibuya, Tokyo',
                    category: 'food',
                    country_code: 'JP',
                  },
                ]),
              ),
              { status: 200, headers: { 'content-type': 'application/json' } },
            ),
          blurb: () =>
            new Response(
              JSON.stringify(
                geminiBlurbResponse([{ id: 'place-maru', blurb: 'Crispy tonkatsu in Shibuya.' }]),
              ),
              { status: 200, headers: { 'content-type': 'application/json' } },
            ),
        }),
      )
      .on('https://places.googleapis.com/v1/places:searchText', () =>
        placesSearchResponse('place-maru'),
      )
      .on('https://places.googleapis.com/v1/places/', () =>
        placesDetailsResponse({
          id: 'place-maru',
          displayName: 'Maru Tonkatsu',
          formattedAddress: '1-2-3 Shibuya, Tokyo, Japan',
          photoName: 'places/place-maru/photos/abc',
          rating: 4.5,
          priceLevel: 'PRICE_LEVEL_MODERATE',
          latitude: 35.659,
          longitude: 139.7,
          city: 'Tokyo',
          countryCode: 'JP',
        }),
      );
    restoreFetch = mock.install();

    const { env, kv } = makeEnv();
    const ctx = makeAwaitableCtx();

    const postResp = await handleExtractPost(
      postExtract({ contentHash: HASH, kind: 'url', url }),
      env,
      ctx,
    );
    expect(postResp.status).toBe(202);
    await ctx.settle();

    const final = await readGet(HASH, env);
    expect(final.status).toBe(200);
    expect(final.body.status).toBe('done');
    if (final.body.status !== 'done') throw new Error('expected done'); // narrow

    expect(final.body.caption).toBe('Best tonkatsu in Tokyo');
    expect(final.body.coverUrl).toBe(coverUrl);
    expect(final.body.videoPresent).toBe(false);
    expect(final.body.places).toHaveLength(1);

    const place = final.body.places[0]!;
    expect(place.name).toBe('Maru Tonkatsu');
    expect(place.city).toBe('Tokyo');
    expect(place.country_code).toBe('JP');
    expect(place.external_place_id).toBe('place-maru');
    expect(place.formatted_address).toBe('1-2-3 Shibuya, Tokyo, Japan');
    expect(place.photo_name).toBe('places/place-maru/photos/abc');
    expect(place.display_name).toBe('Maru Tonkatsu');
    expect(place.rating).toBe(4.5);
    expect(place.price_level).toBe(2);
    expect(place.latitude).toBe(35.659);
    expect(place.longitude).toBe(139.7);
    // Bulk-blurb is now deferred to the client's per-place /enrich
    // retry path — see the `blurb_deferred` comment in orchestrator.ts.
    // Inline orchestrate writes blurb=null, blurb_status='failed'.
    expect(place.blurb).toBeNull();
    expect(place.blurb_status).toBe('failed');

    // og fast path means NO Apify call.
    expect(mock.callsTo('https://api.apify.com/')).toHaveLength(0);

    // Sanity on KV — the orchestrator landed in `done` (not stuck in `partial`).
    expect(kv.store.get(`state:${HASH}`)).toContain('"status":"done"');
  });

  // ----- Scenario 2: IG /p/ carousel via Apify, vision multi-image ----------

  it('IG carousel post: og → Apify fan-out → vision with all slides → 3 places', async () => {
    const url = 'https://www.instagram.com/p/CAR123/';
    const carouselCover = `https://cdn.example/cover.jpg?efg=${efgFor('CAROUSEL_ITEM')}`;
    const slide2 = 'https://cdn.example/slide2.jpg';
    const slide3 = 'https://cdn.example/slide3.jpg';
    const slide4 = 'https://cdn.example/slide4.jpg';
    const slide5 = 'https://cdn.example/slide5.jpg';

    const places = [
      { id: 'place-tartine', name: 'Tartine', city: 'San Francisco', cc: 'US' },
      { id: 'place-mission', name: 'Mission Chinese', city: 'San Francisco', cc: 'US' },
      { id: 'place-zuni', name: 'Zuni Cafe', city: 'San Francisco', cc: 'US' },
    ];

    let detailsCallIdx = 0;
    const mock = createNetworkMock()
      .on('https://api.revenuecat.com/v1/subscribers/', rcActiveHandler())
      .on(
        'https://www.instagram.com/p/',
        () => new Response(igPostHtml({ coverUrl: carouselCover, caption: 'SF food crawl' })),
      )
      .on('https://api.apify.com/', () =>
        apifyResponse([
          {
            url,
            shortCode: 'CAR123',
            caption: 'SF food crawl',
            displayUrl: carouselCover,
            childPosts: [
              { displayUrl: slide2 },
              { displayUrl: slide3 },
              { displayUrl: slide4 },
              { displayUrl: slide5 },
            ],
            type: 'Sidecar',
            ownerUsername: 'foodie',
          },
        ]),
      )
      .on('https://cdn.example/', () => imageResponse())
      .on(
        GEMINI_GATEWAY_PREFIX,
        geminiDispatcher({
          extract: () =>
            new Response(
              JSON.stringify(
                geminiExtractResponse(
                  places.map((p) => ({
                    name: p.name,
                    city: p.city,
                    address: `${p.name} address`,
                    category: 'food' as const,
                    country_code: p.cc,
                  })),
                ),
              ),
            ),
          blurb: () =>
            new Response(
              JSON.stringify(
                geminiBlurbResponse(
                  places.map((p) => ({ id: p.id, blurb: `Blurb for ${p.name}.` })),
                ),
              ),
            ),
        }),
      )
      .on('https://places.googleapis.com/v1/places:searchText', async (req) => {
        // Match the search query to the right placeId. The worker concats
        // name + address + city; we look for the unique name.
        const body = await req.clone().text();
        const match = places.find((p) => body.includes(p.name));
        return placesSearchResponse(match?.id ?? null);
      })
      .on('https://places.googleapis.com/v1/places/', () => {
        const p = places[detailsCallIdx++ % places.length]!;
        return placesDetailsResponse({
          id: p.id,
          displayName: p.name,
          formattedAddress: `${p.name}, ${p.city}, USA`,
          photoName: `places/${p.id}/photos/x`,
          rating: 4.5,
          priceLevel: 'PRICE_LEVEL_MODERATE',
          latitude: 37.76,
          longitude: -122.42,
          city: p.city,
          countryCode: p.cc,
        });
      });
    restoreFetch = mock.install();

    const { env } = makeEnv();
    const ctx = makeAwaitableCtx();
    await handleExtractPost(postExtract({ contentHash: HASH, kind: 'url', url }), env, ctx);
    await ctx.settle();

    const final = await readGet(HASH, env);
    if (final.body.status !== 'done') throw new Error(`expected done, got ${final.body.status}`);
    expect(final.body.places).toHaveLength(3);
    expect(final.body.places.map((p) => p.name).sort()).toEqual(
      ['Mission Chinese', 'Tartine', 'Zuni Cafe'].sort(),
    );
    // Apify-only path: og was tried, then Apify fired. Carousel slide fan-out
    // means the orchestrator fetched all 5 cover/slide URLs.
    expect(mock.callsTo('https://api.apify.com/')).toHaveLength(1);
    expect(mock.callsTo('https://cdn.example/')).toHaveLength(5);
    // All 3 places get enriched inline. Blurbs are deferred — client
    // backfills them via /enrich after the source loads.
    for (const place of final.body.places) {
      expect(place.external_place_id).toBeTruthy();
      expect(place.blurb).toBeNull();
      expect(place.blurb_status).toBe('failed');
    }
  });

  // ----- Scenario 3: IG /reel/ → Apify → video mode succeeds ----------------

  it('IG Reel: skip og → Apify → video mode → done', async () => {
    const url = 'https://www.instagram.com/reel/REEL1/';
    const videoUrl = 'https://cdn.example/reel.mp4';
    const reelCover = 'https://cdn.example/reel-cover.jpg';

    const mock = createNetworkMock()
      .on('https://api.revenuecat.com/v1/subscribers/', rcActiveHandler())
      .on('https://api.apify.com/', () =>
        apifyResponse([
          {
            url,
            shortCode: 'REEL1',
            caption: 'Best Lisbon viewpoint',
            displayUrl: reelCover,
            ownerUsername: 'travel',
            videoUrl,
            videoDuration: 28,
            type: 'Video',
          },
        ]),
      )
      .on('https://cdn.example/', () => imageResponse())
      .on(
        GEMINI_GATEWAY_PREFIX,
        geminiDispatcher({
          extract: () =>
            new Response(
              JSON.stringify(
                geminiExtractResponse([
                  {
                    name: 'Miradouro da Senhora do Monte',
                    city: 'Lisbon',
                    address: 'Lisbon, Portugal',
                    category: 'sights',
                    country_code: 'PT',
                  },
                ]),
              ),
            ),
          blurb: () =>
            new Response(
              JSON.stringify(
                geminiBlurbResponse([{ id: 'place-monte', blurb: 'Panoramic view of Lisbon.' }]),
              ),
            ),
        }),
      )
      .on('https://places.googleapis.com/v1/places:searchText', () =>
        placesSearchResponse('place-monte'),
      )
      .on('https://places.googleapis.com/v1/places/', () =>
        placesDetailsResponse({
          id: 'place-monte',
          displayName: 'Miradouro da Senhora do Monte',
          formattedAddress: 'R. da Sra. do Monte, Lisbon, Portugal',
          photoName: 'places/place-monte/photos/x',
          rating: 4.7,
          priceLevel: 'PRICE_LEVEL_INEXPENSIVE',
          latitude: 38.72,
          longitude: -9.13,
          city: 'Lisbon',
          countryCode: 'PT',
        }),
      );
    restoreFetch = mock.install();

    const { env } = makeEnv();
    const ctx = makeAwaitableCtx();
    await handleExtractPost(postExtract({ contentHash: HASH, kind: 'url', url }), env, ctx);
    await ctx.settle();

    const final = await readGet(HASH, env);
    if (final.body.status !== 'done') throw new Error(`expected done, got ${final.body.status}`);
    expect(final.body.videoPresent).toBe(true);
    expect(final.body.places).toHaveLength(1);
    expect(final.body.places[0]!.name).toBe('Miradouro da Senhora do Monte');

    // /reel/ skips og entirely when Apify is configured — there should be NO
    // fetch to instagram.com (only to api.apify.com).
    expect(mock.callsTo('https://www.instagram.com/')).toHaveLength(0);
    expect(mock.callsTo('https://api.apify.com/')).toHaveLength(1);
    // Video mode means the CDN video URL was fetched (in addition to the
    // cover image fetch the orchestrator does up-front).
    const cdnCalls = mock.callsTo('https://cdn.example/');
    expect(cdnCalls.some((c) => c.url === videoUrl)).toBe(true);
  });

  // ----- Scenario 5: TikTok video → skip video mode → vision succeeds -------

  it('TikTok video post: skip video mode (CDN-blocked), vision on cover succeeds', async () => {
    const url = 'https://www.tiktok.com/@food/video/7300000000000000000';
    const cover = 'https://p16-sign-va.tiktokcdn.com/cover.jpg';
    const videoUrl = 'https://v16-webapp.tiktok.com/play/abc.mp4';

    const mock = createNetworkMock()
      .on('https://api.revenuecat.com/v1/subscribers/', rcActiveHandler())
      .on(
        'https://www.tiktok.com/@',
        () =>
          new Response(
            tiktokVideoHtml({
              caption: 'Hidden ramen spot in Osaka',
              authorUniqueId: 'food',
              coverUrl: cover,
              playAddr: videoUrl,
              duration: 22,
            }),
          ),
      )
      // NOTE: deliberately NO route for videoUrl. If the orchestrator
      // attempts video mode despite platform === 'tiktok', the unmatched
      // fetch throws and the test fails. That's the regression guard for
      // commit f9a224e.
      .on('https://p16-sign-va.tiktokcdn.com/', () => imageResponse())
      .on(
        GEMINI_GATEWAY_PREFIX,
        geminiDispatcher({
          extract: () =>
            new Response(
              JSON.stringify(
                geminiExtractResponse([
                  {
                    name: 'Tonkotsu Ramen Bar',
                    city: 'Osaka',
                    address: 'Namba, Osaka',
                    category: 'food',
                    country_code: 'JP',
                  },
                ]),
              ),
            ),
          blurb: () =>
            new Response(
              JSON.stringify(
                geminiBlurbResponse([
                  { id: 'place-ramen', blurb: 'A late-night counter in Namba.' },
                ]),
              ),
            ),
        }),
      )
      .on('https://places.googleapis.com/v1/places:searchText', () =>
        placesSearchResponse('place-ramen'),
      )
      .on('https://places.googleapis.com/v1/places/', () =>
        placesDetailsResponse({
          id: 'place-ramen',
          displayName: 'Tonkotsu Ramen Bar',
          formattedAddress: 'Namba, Osaka, Japan',
          photoName: 'places/place-ramen/photos/x',
          rating: 4.4,
          priceLevel: 'PRICE_LEVEL_INEXPENSIVE',
          latitude: 34.66,
          longitude: 135.5,
          city: 'Osaka',
          countryCode: 'JP',
        }),
      );
    restoreFetch = mock.install();

    const { env } = makeEnv();
    const ctx = makeAwaitableCtx();
    await handleExtractPost(postExtract({ contentHash: HASH, kind: 'url', url }), env, ctx);
    await ctx.settle();

    const final = await readGet(HASH, env);
    if (final.body.status !== 'done') throw new Error(`expected done, got ${final.body.status}`);
    expect(final.body.videoPresent).toBe(true);
    expect(final.body.places).toHaveLength(1);

    // Critical: NO call to the video CDN. Vision was used instead.
    expect(mock.callsTo('https://v16-webapp.tiktok.com/')).toHaveLength(0);
    // Cover image WAS fetched (for vision mode).
    expect(mock.callsTo('https://p16-sign-va.tiktokcdn.com/').length).toBeGreaterThan(0);
  });

  // ----- Scenario 8: Gemini 503 across all modes → partial preserved --------

  it('Gemini 503 on every fallback mode → partial state preserved, no terminal error', async () => {
    const url = 'https://www.instagram.com/reel/REEL2/';
    const videoUrl = 'https://cdn.example/reel2.mp4';
    const reelCover = 'https://cdn.example/reel2-cover.jpg';

    const mock = createNetworkMock()
      .on('https://api.revenuecat.com/v1/subscribers/', rcActiveHandler())
      .on('https://api.apify.com/', () =>
        apifyResponse([
          {
            url,
            shortCode: 'REEL2',
            caption: 'Some travel spot',
            displayUrl: reelCover,
            videoUrl,
            videoDuration: 30,
            type: 'Video',
            ownerUsername: 'traveler',
          },
        ]),
      )
      .on('https://cdn.example/', () => imageResponse())
      // Every Gemini call returns 503 — both the extract attempts (video,
      // vision, text fallback ladder) and any blurb call. The orchestrator
      // should never reach enrichment, so Places routes are intentionally
      // omitted (unmatched-fetch would fail the test).
      .on(GEMINI_GATEWAY_PREFIX, () => new Response('upstream busy', { status: 503 }));
    restoreFetch = mock.install();

    const { env, kv } = makeEnv();
    const ctx = makeAwaitableCtx();
    await handleExtractPost(postExtract({ contentHash: HASH, kind: 'url', url }), env, ctx);
    await ctx.settle();

    // Final state: `partial` (caption + cover preserved for the triage card),
    // NOT `error`. The next stale-pending recovery POST will retry.
    const final = await readGet(HASH, env);
    if (final.body.status !== 'partial') {
      throw new Error(`expected partial, got ${final.body.status}`);
    }
    expect(final.body.caption).toBe('Some travel spot');
    expect(final.body.coverUrl).toBe(reelCover);
    expect(final.body.videoPresent).toBe(true);

    // KV reflects the same — no terminal `error` write happened.
    const raw = kv.store.get(`state:${HASH}`);
    expect(raw).toContain('"status":"partial"');
    expect(raw).not.toContain('"status":"error"');

    // Every Gemini call returned 503; each runExtract attempt does one
    // transient retry → 2 calls per mode. Video + vision + text = 6 total.
    expect(mock.callsTo(GEMINI_GATEWAY_PREFIX)).toHaveLength(6);

    // No Places calls — orchestrator bailed before enrichment.
    expect(mock.callsTo('https://places.googleapis.com/')).toHaveLength(0);
  });

  // ----- Scenario 4: IG /reel/ with Apify NOT configured (soft-degrade) -----

  it('IG Reel without Apify: og soft-degrade → vision on cover → done', async () => {
    const url = 'https://www.instagram.com/reel/REEL3/';
    const cover = 'https://cdn.example/reel3-cover.jpg';

    const mock = createNetworkMock()
      .on('https://api.revenuecat.com/v1/subscribers/', rcActiveHandler())
      .on(
        'https://www.instagram.com/p/',
        () => new Response(igPostHtml({ coverUrl: cover, caption: 'Sunset rooftop bar' })),
      )
      .on('https://cdn.example/', () => imageResponse())
      .on(
        GEMINI_GATEWAY_PREFIX,
        geminiDispatcher({
          extract: () =>
            new Response(
              JSON.stringify(
                geminiExtractResponse([
                  {
                    name: 'Skybar',
                    city: 'Bangkok',
                    address: 'Lebua, Bangkok',
                    category: 'drinks',
                    country_code: 'TH',
                  },
                ]),
              ),
            ),
          blurb: () =>
            new Response(
              JSON.stringify(geminiBlurbResponse([{ id: 'place-skybar', blurb: 'Rooftop bar.' }])),
            ),
        }),
      )
      .on('https://places.googleapis.com/v1/places:searchText', () =>
        placesSearchResponse('place-skybar'),
      )
      .on('https://places.googleapis.com/v1/places/', () =>
        placesDetailsResponse({
          id: 'place-skybar',
          displayName: 'Sky Bar at Lebua',
          formattedAddress: '1055 Si Lom, Bangkok, Thailand',
          photoName: 'places/place-skybar/photos/x',
          rating: 4.4,
          priceLevel: 'PRICE_LEVEL_EXPENSIVE',
          latitude: 13.72,
          longitude: 100.52,
          city: 'Bangkok',
          countryCode: 'TH',
        }),
      );
    restoreFetch = mock.install();

    // apify: false → APIFY_TOKEN unset → fetchInstagram takes the
    // og_only_apify_disabled branch instead of skipping og.
    const { env } = makeEnv({ apify: false });
    const ctx = makeAwaitableCtx();
    await handleExtractPost(postExtract({ contentHash: HASH, kind: 'url', url }), env, ctx);
    await ctx.settle();

    const final = await readGet(HASH, env);
    if (final.body.status !== 'done') throw new Error(`expected done, got ${final.body.status}`);
    expect(final.body.videoPresent).toBe(false); // og had no og:video tag
    expect(final.body.places).toHaveLength(1);
    expect(final.body.places[0]!.display_name).toBe('Sky Bar at Lebua');

    // Critical: og was tried (1 fetch to instagram.com), no Apify call.
    expect(mock.callsTo('https://www.instagram.com/').length).toBeGreaterThan(0);
    expect(mock.callsTo('https://api.apify.com/')).toHaveLength(0);
  });

  // ----- Scenario 6: TikTok photo slideshow → vision multi-image -----------

  it('TikTok photo slideshow: rehydration → vision with all slides → done', async () => {
    const url = 'https://www.tiktok.com/@traveler/photo/7300000000000000001';
    const slides = [
      'https://p16-sign-va.tiktokcdn.com/slide1.jpg',
      'https://p16-sign-va.tiktokcdn.com/slide2.jpg',
      'https://p16-sign-va.tiktokcdn.com/slide3.jpg',
      'https://p16-sign-va.tiktokcdn.com/slide4.jpg',
    ];

    const mock = createNetworkMock()
      .on('https://api.revenuecat.com/v1/subscribers/', rcActiveHandler())
      .on(
        'https://www.tiktok.com/@',
        () =>
          new Response(
            tiktokPhotoHtml({
              caption: '4 hidden gems in Kyoto',
              authorUniqueId: 'traveler',
              imageUrls: slides,
            }),
          ),
      )
      .on('https://p16-sign-va.tiktokcdn.com/', () => imageResponse())
      .on(
        GEMINI_GATEWAY_PREFIX,
        geminiDispatcher({
          extract: () =>
            new Response(
              JSON.stringify(
                geminiExtractResponse([
                  {
                    name: 'Fushimi Inari',
                    city: 'Kyoto',
                    address: 'Fushimi Ward, Kyoto',
                    category: 'sights',
                    country_code: 'JP',
                  },
                ]),
              ),
            ),
          blurb: () =>
            new Response(
              JSON.stringify(geminiBlurbResponse([{ id: 'place-inari', blurb: 'Red torii.' }])),
            ),
        }),
      )
      .on('https://places.googleapis.com/v1/places:searchText', () =>
        placesSearchResponse('place-inari'),
      )
      .on('https://places.googleapis.com/v1/places/', () =>
        placesDetailsResponse({
          id: 'place-inari',
          displayName: 'Fushimi Inari Taisha',
          formattedAddress: '68 Fukakusa Yabunouchichō, Fushimi Ward, Kyoto, Japan',
          photoName: 'places/place-inari/photos/x',
          rating: 4.7,
          priceLevel: 'PRICE_LEVEL_INEXPENSIVE',
          latitude: 34.97,
          longitude: 135.77,
          city: 'Kyoto',
          countryCode: 'JP',
        }),
      );
    restoreFetch = mock.install();

    const { env } = makeEnv();
    const ctx = makeAwaitableCtx();
    await handleExtractPost(postExtract({ contentHash: HASH, kind: 'url', url }), env, ctx);
    await ctx.settle();

    const final = await readGet(HASH, env);
    if (final.body.status !== 'done') throw new Error(`expected done, got ${final.body.status}`);
    expect(final.body.videoPresent).toBe(false); // photo-slideshow has no videoUrl
    expect(final.body.places).toHaveLength(1);
    // All 4 slides should have been fetched for vision mode.
    expect(mock.callsTo('https://p16-sign-va.tiktokcdn.com/')).toHaveLength(4);
  });

  // ----- Scenario 7: TikTok rehydration fail → oEmbed fallback -------------

  it('TikTok rehydration absent → oEmbed fallback → vision succeeds', async () => {
    const url = 'https://www.tiktok.com/@blocked/video/7300000000000000002';
    const oembedThumb = 'https://p16-sign-va.tiktokcdn.com/oembed-thumb.jpg';

    const mock = createNetworkMock()
      .on('https://api.revenuecat.com/v1/subscribers/', rcActiveHandler())
      // HTML route returns a no-rehydration page → primary parser throws,
      // worker falls through to oEmbed.
      .on('https://www.tiktok.com/@', () => new Response(tiktokNoRehydrationHtml()))
      .on('https://www.tiktok.com/oembed', () =>
        tiktokOembedResponse({
          title: 'Best pho in Hanoi',
          thumbnailUrl: oembedThumb,
          authorName: 'foodie',
        }),
      )
      .on('https://p16-sign-va.tiktokcdn.com/', () => imageResponse())
      .on(
        GEMINI_GATEWAY_PREFIX,
        geminiDispatcher({
          extract: () =>
            new Response(
              JSON.stringify(
                geminiExtractResponse([
                  {
                    name: 'Pho Gia Truyen',
                    city: 'Hanoi',
                    address: '49 Bat Dan, Hanoi',
                    category: 'food',
                    country_code: 'VN',
                  },
                ]),
              ),
            ),
          blurb: () =>
            new Response(
              JSON.stringify(geminiBlurbResponse([{ id: 'place-pho', blurb: 'Hanoi pho.' }])),
            ),
        }),
      )
      .on('https://places.googleapis.com/v1/places:searchText', () =>
        placesSearchResponse('place-pho'),
      )
      .on('https://places.googleapis.com/v1/places/', () =>
        placesDetailsResponse({
          id: 'place-pho',
          displayName: 'Pho Gia Truyen',
          formattedAddress: '49 Bat Dan, Hanoi, Vietnam',
          photoName: 'places/place-pho/photos/x',
          rating: 4.5,
          priceLevel: 'PRICE_LEVEL_INEXPENSIVE',
          latitude: 21.03,
          longitude: 105.85,
          city: 'Hanoi',
          countryCode: 'VN',
        }),
      );
    restoreFetch = mock.install();

    const { env } = makeEnv();
    const ctx = makeAwaitableCtx();
    await handleExtractPost(postExtract({ contentHash: HASH, kind: 'url', url }), env, ctx);
    await ctx.settle();

    const final = await readGet(HASH, env);
    if (final.body.status !== 'done') throw new Error(`expected done, got ${final.body.status}`);
    expect(final.body.coverUrl).toBe(oembedThumb);
    expect(final.body.places).toHaveLength(1);

    // Both primary HTML AND oEmbed were called (primary failed, oEmbed
    // succeeded).
    expect(mock.callsTo('https://www.tiktok.com/@').length).toBeGreaterThan(0);
    expect(mock.callsTo('https://www.tiktok.com/oembed')).toHaveLength(1);
  });

  // ----- Scenario 9: Gemini schema violation → terminal `error` -------------

  it('Gemini returns schema-violating inner JSON → terminal error (non-transient)', async () => {
    const url = 'https://www.instagram.com/p/BAD1/';
    const coverUrl = `https://cdn.example/cover.jpg?efg=${efgFor('GraphImage')}`;

    const badInner = { foo: 'bar' }; // missing top-level `places` array
    const mock = createNetworkMock()
      .on('https://api.revenuecat.com/v1/subscribers/', rcActiveHandler())
      .on(
        'https://www.instagram.com/p/',
        () => new Response(igPostHtml({ coverUrl, caption: 'a caption' })),
      )
      .on('https://cdn.example/', () => imageResponse())
      // 200 OK envelope, but inner candidate text fails the responseSchema.
      // runExtract throws RunExtractError('upstream-schema-violation') which
      // is NOT in the transient set, so the fallback ladder ends with a
      // generic Error (not TransientExtractError) and orchestrate writes a
      // terminal `error` state.
      .on(
        GEMINI_GATEWAY_PREFIX,
        () =>
          new Response(
            JSON.stringify({
              candidates: [{ content: { parts: [{ text: JSON.stringify(badInner) }] } }],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
      );
    restoreFetch = mock.install();

    const { env, kv } = makeEnv();
    const ctx = makeAwaitableCtx();
    await handleExtractPost(postExtract({ contentHash: HASH, kind: 'url', url }), env, ctx);
    await ctx.settle();

    const final = await readGet(HASH, env);
    if (final.body.status !== 'error') throw new Error(`expected error, got ${final.body.status}`);
    expect(final.body.error).toBe('extract-failed');
    // Terminal state — caption + cover still attached so the triage card
    // can still render something useful.
    expect(final.body.caption).toBe('a caption');
    expect(final.body.coverUrl).toBe(coverUrl);

    const raw = kv.store.get(`state:${HASH}`);
    expect(raw).toContain('"status":"error"');
    expect(raw).not.toContain('"status":"partial"');

    // No enrichment — Places routes were never registered and would have
    // thrown 'unmatched fetch' if hit.
    expect(mock.callsTo('https://places.googleapis.com/')).toHaveLength(0);
  });

  // ----- Scenario 10: Apify returns truly empty post → no-extractable-content

  it('empty post (no caption, no images, no video) → terminal no-extractable-content', async () => {
    const url = 'https://www.instagram.com/reel/EMPTY/';

    const mock = createNetworkMock()
      .on('https://api.revenuecat.com/v1/subscribers/', rcActiveHandler())
      // Apify returns an item with everything blank. mapApifyItem then
      // produces { caption: '', imageUrls: [], videoUrl: null }, so
      // tryExtractWithFallback finds nothing to send to Gemini and throws
      // no-extractable-content (errors array empty).
      .on('https://api.apify.com/', () =>
        apifyResponse([{ url, shortCode: 'EMPTY', caption: '', displayUrl: '', type: 'Sidecar' }]),
      );
    restoreFetch = mock.install();

    const { env } = makeEnv();
    const ctx = makeAwaitableCtx();
    await handleExtractPost(postExtract({ contentHash: HASH, kind: 'url', url }), env, ctx);
    await ctx.settle();

    const final = await readGet(HASH, env);
    if (final.body.status !== 'error') throw new Error(`expected error, got ${final.body.status}`);
    expect(final.body.error).toBe('no-extractable-content');
    // No Gemini, no Places.
    expect(mock.callsTo(GEMINI_GATEWAY_PREFIX)).toHaveLength(0);
    expect(mock.callsTo('https://places.googleapis.com/')).toHaveLength(0);
  });

  // ----- Scenario 11: Carousel with partial slide-fetch failures ------------

  it('carousel with 2 mid-slide 403s → vision succeeds with 6-slide subset', async () => {
    const url = 'https://www.instagram.com/p/CAR11/';
    const cover = `https://cdn.example/slide1.jpg?efg=${efgFor('CAROUSEL_ITEM')}`;
    const slides = [
      cover,
      'https://cdn.example/slide2.jpg',
      'https://cdn.example/slide3.jpg', // 403
      'https://cdn.example/slide4.jpg',
      'https://cdn.example/slide5.jpg',
      'https://cdn.example/slide6.jpg',
      'https://cdn.example/slide7.jpg', // 403
      'https://cdn.example/slide8.jpg',
    ];
    const failingSlides = new Set([slides[2], slides[6]]);

    const mock = createNetworkMock()
      .on('https://api.revenuecat.com/v1/subscribers/', rcActiveHandler())
      .on(
        'https://www.instagram.com/p/',
        () => new Response(igPostHtml({ coverUrl: cover, caption: '8 SF stops' })),
      )
      .on('https://api.apify.com/', () =>
        apifyResponse([
          {
            url,
            shortCode: 'CAR11',
            caption: '8 SF stops',
            displayUrl: cover,
            childPosts: slides.slice(1).map((u) => ({ displayUrl: u })),
            type: 'Sidecar',
          },
        ]),
      )
      // First-match-wins: specific 403 routes for the 2 failing slide URLs,
      // then the cdn.example catchall for the rest.
      .on(
        (u: string) => failingSlides.has(u),
        () => new Response('blocked', { status: 403 }),
      )
      .on('https://cdn.example/', () => imageResponse())
      .on(
        GEMINI_GATEWAY_PREFIX,
        geminiDispatcher({
          extract: () =>
            new Response(
              JSON.stringify(
                geminiExtractResponse([
                  {
                    name: 'Tartine Bakery',
                    city: 'San Francisco',
                    address: '600 Guerrero St',
                    category: 'food',
                    country_code: 'US',
                  },
                ]),
              ),
            ),
          blurb: () =>
            new Response(
              JSON.stringify(geminiBlurbResponse([{ id: 'place-t', blurb: 'Sourdough.' }])),
            ),
        }),
      )
      .on('https://places.googleapis.com/v1/places:searchText', () =>
        placesSearchResponse('place-t'),
      )
      .on('https://places.googleapis.com/v1/places/', () =>
        placesDetailsResponse({
          id: 'place-t',
          displayName: 'Tartine Bakery',
          formattedAddress: '600 Guerrero St, San Francisco, CA, USA',
          photoName: 'places/place-t/photos/x',
          rating: 4.5,
          priceLevel: 'PRICE_LEVEL_MODERATE',
          latitude: 37.76,
          longitude: -122.42,
          city: 'San Francisco',
          countryCode: 'US',
        }),
      );
    restoreFetch = mock.install();

    const { env } = makeEnv();
    const ctx = makeAwaitableCtx();
    await handleExtractPost(postExtract({ contentHash: HASH, kind: 'url', url }), env, ctx);
    await ctx.settle();

    const final = await readGet(HASH, env);
    if (final.body.status !== 'done') throw new Error(`expected done, got ${final.body.status}`);
    expect(final.body.places).toHaveLength(1);

    // All 8 slide URLs were attempted (2 failed, 6 succeeded). The Gemini
    // call therefore received 6 base64 images. We can't easily count the
    // base64 entries in the request body without parsing, so verify the
    // outcome (orchestrator didn't bail on partial failures).
    expect(mock.callsTo('https://cdn.example/')).toHaveLength(8);
  });

  // ----- Scenario 12: place_id collision dedup ------------------------------

  it('two extracted places resolve to same Google place_id → 1 survivor', async () => {
    const url = 'https://www.instagram.com/p/DUPE/';
    const coverUrl = `https://cdn.example/cover.jpg?efg=${efgFor('GraphImage')}`;

    const mock = createNetworkMock()
      .on('https://api.revenuecat.com/v1/subscribers/', rcActiveHandler())
      .on(
        'https://www.instagram.com/p/',
        () => new Response(igPostHtml({ coverUrl, caption: 'tartine twice' })),
      )
      .on('https://cdn.example/', () => imageResponse())
      .on(
        GEMINI_GATEWAY_PREFIX,
        geminiDispatcher({
          extract: () =>
            new Response(
              JSON.stringify(
                geminiExtractResponse([
                  {
                    name: 'Tartine',
                    city: 'San Francisco',
                    address: '600 Guerrero',
                    category: 'food',
                    country_code: 'US',
                  },
                  {
                    name: 'Tartine Bakery SF',
                    city: 'San Francisco',
                    address: '600 Guerrero St',
                    category: 'food',
                    country_code: 'US',
                  },
                ]),
              ),
            ),
          blurb: () =>
            new Response(
              JSON.stringify(geminiBlurbResponse([{ id: 'place-tartine', blurb: 'Sourdough.' }])),
            ),
        }),
      )
      // Both Places searches resolve to the same place_id — that's the
      // collision the dedup loop in enrichAndWriteDone is designed to
      // catch.
      .on('https://places.googleapis.com/v1/places:searchText', () =>
        placesSearchResponse('place-tartine'),
      )
      .on('https://places.googleapis.com/v1/places/', () =>
        placesDetailsResponse({
          id: 'place-tartine',
          displayName: 'Tartine Bakery',
          formattedAddress: '600 Guerrero St, San Francisco, CA, USA',
          photoName: 'places/place-tartine/photos/x',
          rating: 4.6,
          priceLevel: 'PRICE_LEVEL_MODERATE',
          latitude: 37.76,
          longitude: -122.42,
          city: 'San Francisco',
          countryCode: 'US',
        }),
      );
    restoreFetch = mock.install();

    const { env } = makeEnv();
    const ctx = makeAwaitableCtx();
    await handleExtractPost(postExtract({ contentHash: HASH, kind: 'url', url }), env, ctx);
    await ctx.settle();

    const final = await readGet(HASH, env);
    if (final.body.status !== 'done') throw new Error(`expected done, got ${final.body.status}`);
    expect(final.body.places).toHaveLength(1);
    expect(final.body.places[0]!.external_place_id).toBe('place-tartine');
    // First occurrence wins: the LLM's first emitted name should survive.
    expect(final.body.places[0]!.name).toBe('Tartine');

    // 2 search calls (one per LLM-emitted place), 2 details calls.
    expect(mock.callsTo('https://places.googleapis.com/v1/places:searchText')).toHaveLength(2);
    expect(
      mock.callsTo('https://places.googleapis.com/v1/places/').filter((c) => c.method === 'GET'),
    ).toHaveLength(2);
  });
});
