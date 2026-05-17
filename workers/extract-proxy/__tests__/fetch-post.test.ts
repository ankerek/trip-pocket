import {
  detectPlatform,
  decodeHtmlEntities,
  findOgMeta,
  parseInstagramShortcode,
  parseInstagramUrlShape,
  decodeEfgFromImageUrl,
  extractAuthorFromIgTitle,
  extractAuthorFromTikTokUrl,
  extractAuthorFromTikTokTitle,
  handleFetchPost,
} from '../src/fetch-post';
import type { FetchPostResponse } from '../src/fetch-post';
import type { Env } from '../src/index';

const VALID_ID = '$RCAnonymousID:0123456789abcdef0123456789abcdef';

const RC_ACTIVE = new Response(
  JSON.stringify({
    subscriber: {
      entitlements: { pro: { expires_date: new Date(Date.now() + 60_000).toISOString() } },
    },
  }),
  { status: 200, headers: { 'content-type': 'application/json' } },
);

// --- Pure-function unit tests --------------------------------------------

describe('detectPlatform', () => {
  it.each([
    ['https://www.instagram.com/p/ABC/', 'instagram'],
    ['https://instagram.com/p/ABC/', 'instagram'],
    ['https://m.instagram.com/p/ABC/', 'instagram'],
    ['https://www.tiktok.com/@x/video/1', 'tiktok'],
    ['https://vm.tiktok.com/abc/', 'tiktok'],
    ['https://vt.tiktok.com/abc/', 'tiktok'],
    ['https://www.youtube.com/watch?v=x', null],
    ['https://example.com/', null],
  ])('classifies %s → %s', (url, expected) => {
    expect(detectPlatform(new URL(url))).toBe(expected);
  });
});

describe('decodeHtmlEntities', () => {
  it('handles numeric entities (hex + decimal)', () => {
    expect(decodeHtmlEntities('caf&#x65;')).toBe('cafe');
    expect(decodeHtmlEntities('caf&#101;')).toBe('cafe');
  });
  it('handles named entities', () => {
    expect(decodeHtmlEntities('a&amp;b')).toBe('a&b');
    expect(decodeHtmlEntities('&quot;hi&quot;')).toBe('"hi"');
    expect(decodeHtmlEntities('&apos;')).toBe("'");
    expect(decodeHtmlEntities('&lt;tag&gt;')).toBe('<tag>');
    expect(decodeHtmlEntities('a&nbsp;b')).toBe('a b');
  });
  it('handles emoji (multi-byte hex)', () => {
    // 🇯🇵 = U+1F1EF U+1F1F5
    expect(decodeHtmlEntities('&#x1f1ef;&#x1f1f5;')).toBe('🇯🇵');
  });
  it('ignores garbage codepoints rather than throwing', () => {
    expect(decodeHtmlEntities('&#xffffffff;')).toBe('');
  });
});

describe('findOgMeta', () => {
  const ogIg =
    '<meta property="og:image" content="https://cdn/img.jpg" />' +
    '<meta property="og:description" content="hello world" />';
  it('returns content for property-first attributes', () => {
    expect(findOgMeta(ogIg, 'og:image')).toBe('https://cdn/img.jpg');
    expect(findOgMeta(ogIg, 'og:description')).toBe('hello world');
  });
  it('also handles content-first ordering', () => {
    const html = '<meta content="https://cdn/img.jpg" property="og:image" />';
    expect(findOgMeta(html, 'og:image')).toBe('https://cdn/img.jpg');
  });
  it('returns null when missing', () => {
    expect(findOgMeta('<html></html>', 'og:image')).toBeNull();
  });
});

describe('parseInstagramShortcode', () => {
  it.each([
    ['https://www.instagram.com/p/ABC123/', 'ABC123'],
    ['https://www.instagram.com/reel/XYZ-456_a/', 'XYZ-456_a'],
    ['https://www.instagram.com/tv/QQQ/', 'QQQ'],
    ['https://www.instagram.com/explore/', null],
    ['https://www.instagram.com/', null],
  ])('parses %s → %s', (url, expected) => {
    expect(parseInstagramShortcode(new URL(url))).toBe(expected);
  });
});

describe('extractAuthorFromIgTitle', () => {
  it('pulls display name before " on Instagram:"', () => {
    expect(
      extractAuthorFromIgTitle(
        'Natalia &amp; Karolina | Travel Content Creators | on Instagram: "..."',
      ),
    ).toBe('Natalia & Karolina | Travel Content Creators |');
  });
  it('handles the " on Instagram" form without colon', () => {
    expect(extractAuthorFromIgTitle('Foo on Instagram')).toBe('Foo');
  });
  it('returns null on null/no-match', () => {
    expect(extractAuthorFromIgTitle(null)).toBeNull();
    expect(extractAuthorFromIgTitle('Something else entirely')).toBeNull();
  });
});

describe('parseInstagramUrlShape', () => {
  it.each([
    ['https://www.instagram.com/p/ABC/', 'p'],
    ['https://www.instagram.com/reel/XYZ/', 'reel'],
    ['https://www.instagram.com/tv/QQQ/', 'tv'],
    ['https://www.instagram.com/explore/', null],
  ])('classifies %s → %s', (url, expected) => {
    expect(parseInstagramUrlShape(new URL(url))).toBe(expected);
  });
});

describe('decodeEfgFromImageUrl', () => {
  const carouselB64 = 'eyJtZWRpYV90eXBlIjoiQ0FST1VTRUxfSVRFTSJ9';
  const singleB64 = 'eyJtZWRpYV90eXBlIjoiR3JhcGhJbWFnZSJ9';
  const clipsB64 = 'eyJtZWRpYV90eXBlIjoiQ0xJUFMifQ==';

  it('decodes CAROUSEL_ITEM → carousel', () => {
    expect(decodeEfgFromImageUrl(`https://cdn/x.jpg?efg=${carouselB64}`)).toBe('carousel');
  });
  it('decodes GraphImage → single', () => {
    expect(decodeEfgFromImageUrl(`https://cdn/x.jpg?efg=${singleB64}`)).toBe('single');
  });
  it('decodes CLIPS → clips', () => {
    expect(decodeEfgFromImageUrl(`https://cdn/x.jpg?efg=${clipsB64}`)).toBe('clips');
  });
  it('returns null when efg is missing', () => {
    expect(decodeEfgFromImageUrl('https://cdn/x.jpg')).toBeNull();
  });
  it('returns null when efg is unparseable garbage', () => {
    expect(decodeEfgFromImageUrl('https://cdn/x.jpg?efg=!!!')).toBeNull();
  });
  it('returns null when decoded media_type is unrecognised', () => {
    const odd = Buffer.from('{"media_type":"FUTURE_TOKEN"}').toString('base64');
    expect(decodeEfgFromImageUrl(`https://cdn/x.jpg?efg=${odd}`)).toBeNull();
  });
  it('returns null on an unparseable image URL', () => {
    expect(decodeEfgFromImageUrl('not a url')).toBeNull();
  });
  it('returns null on empty input', () => {
    expect(decodeEfgFromImageUrl('')).toBeNull();
  });
});

describe('TikTok author helpers', () => {
  it('extractAuthorFromTikTokUrl reads /@handle/ from /video/ and /photo/ paths', () => {
    expect(extractAuthorFromTikTokUrl(new URL('https://www.tiktok.com/@khaby/video/12'))).toBe(
      '@khaby',
    );
    expect(extractAuthorFromTikTokUrl(new URL('https://www.tiktok.com/@khaby/photo/12'))).toBe(
      '@khaby',
    );
    expect(extractAuthorFromTikTokUrl(new URL('https://www.tiktok.com/'))).toBeNull();
  });
  it('extractAuthorFromTikTokTitle takes prefix before " on TikTok"', () => {
    expect(extractAuthorFromTikTokTitle('Khaby on TikTok: x')).toBe('Khaby');
    expect(extractAuthorFromTikTokTitle(null)).toBeNull();
  });
});

// --- Integration tests for handleFetchPost -------------------------------

// Install caches.default polyfill and a default RC fetch mock before every
// integration test so that requireEntitlement works in the Node Jest environment.
// Individual test describes override globalThis.fetch / global.fetch as needed.
let originalFetch: typeof globalThis.fetch;
beforeEach(() => {
  originalFetch = globalThis.fetch;

  const store = new Map<string, Response>();
  // @ts-expect-error — test polyfill
  globalThis.caches = {
    default: {
      async match(key: Request) {
        const k = key.url;
        const r = store.get(k);
        return r ? r.clone() : undefined;
      },
      async put(key: Request, value: Response) {
        store.set(key.url, value.clone());
      },
    },
  };

  // Default fetch handles RC entitlement; tests that need platform fetches
  // override via scriptedFetch (which also prepends the RC matcher).
  globalThis.fetch = jest.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.startsWith('https://api.revenuecat.com/v1/subscribers/')) {
      return RC_ACTIVE.clone();
    }
    throw new Error(`unexpected fetch in test (no override): ${url}`);
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function rateLimit(allowed = true) {
  return { limit: jest.fn(async () => ({ success: allowed })) };
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    GEMINI_API_KEY: 'gemini',
    GOOGLE_PLACES_API_KEY: 'places',
    CF_ACCOUNT_ID: 'acct',
    AI_GATEWAY_NAME: 'gw',
    CF_AIG_TOKEN: 'tok',
    RATE_LIMIT: rateLimit(true) as unknown as Env['RATE_LIMIT'],
    RC_REST_API_KEY: 'rc-key',
    ...overrides,
  };
}

function postJson(body: unknown, ip = '1.2.3.4'): Request {
  return new Request('https://proxy.example.com/fetch-post', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'CF-Connecting-IP': ip,
      'X-RC-User-Id': VALID_ID,
    },
    body: JSON.stringify(body),
  });
}

type FetchScript = Array<{
  match: (url: string, init?: RequestInit) => boolean;
  response: () => Response;
}>;

function scriptedFetch(script: FetchScript) {
  // Always prepend the RC-subscribers matcher so that requireEntitlement is
  // satisfied without having to modify every callsite.
  const withRc = withRcMatcher(script);
  return jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    for (const step of withRc) {
      if (step.match(url, init)) return step.response();
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;
}

// Prepends an RC-subscribers matcher so all scripted fetch mocks satisfy
// the requireEntitlement gate without changing existing script entries.
function withRcMatcher(script: FetchScript): FetchScript {
  return [
    {
      match: (url) => url.startsWith('https://api.revenuecat.com/v1/subscribers/'),
      response: () => RC_ACTIVE.clone(),
    },
    ...script,
  ];
}

const IG_OG_HTML = (caption: string, image: string, title: string) =>
  `<html><head>
    <meta property="og:title" content="${title}" />
    <meta property="og:description" content="${caption}" />
    <meta property="og:image" content="${image}" />
  </head></html>`;

// Minimal HTML envelope for the TikTok rehydration parser. Wraps an
// `itemStruct` shape under the documented field path.
function ttRehydHtml(item: object): string {
  const data = JSON.stringify({
    __DEFAULT_SCOPE__: {
      'webapp.reflow.video.detail': {
        itemInfo: { itemStruct: item },
      },
    },
  });
  return (
    '<!doctype html><html><body>' +
    `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${data}</script>` +
    '</body></html>'
  );
}

// IG embeds a base64 `efg` query param on og:image that encodes the post
// type. Tests that exercise the og:-only path need to use an image URL with
// efg=<base64 of {"media_type":"GraphImage"}> so the dispatch resolves to
// 'single' and Apify is correctly NOT called.
const EFG_SINGLE = 'eyJtZWRpYV90eXBlIjoiR3JhcGhJbWFnZSJ9';
const EFG_CAROUSEL = 'eyJtZWRpYV90eXBlIjoiQ0FST1VTRUxfSVRFTSJ9';
const IG_COVER_SINGLE = `https://scontent.cdninstagram.com/cover.jpg?efg=${EFG_SINGLE}`;
const IG_COVER_CAROUSEL = `https://scontent.cdninstagram.com/cover.jpg?efg=${EFG_CAROUSEL}`;

describe('handleFetchPost — Instagram', () => {
  it('parses og tags from the canonical post URL and returns success (single, no Apify)', async () => {
    const html = IG_OG_HTML(
      'Mt Fuji spots: Chureito Pagoda, Fujisan Yumeno Ohashi Bridge',
      IG_COVER_SINGLE,
      'Natalia &amp; Karolina on Instagram: &quot;...&quot;',
    );
    global.fetch = scriptedFetch([
      {
        match: (url) => url === 'https://www.instagram.com/p/ABC123/',
        response: () =>
          new Response(html, {
            status: 200,
            headers: { 'content-type': 'text/html' },
          }),
      },
    ]);

    const resp = await handleFetchPost(
      postJson({ url: 'https://www.instagram.com/p/ABC123/' }),
      makeEnv(),
    );
    expect(resp.status).toBe(200);
    expect(resp.headers.get('cache-control')).toContain('s-maxage=86400');
    const body = (await resp.json()) as FetchPostResponse;
    expect(body.platform).toBe('instagram');
    expect(body.permalink).toBe('https://www.instagram.com/p/ABC123/');
    expect(body.caption).toContain('Chureito Pagoda');
    expect(body.imageUrls).toEqual([IG_COVER_SINGLE]);
    expect(body.author).toBe('Natalia & Karolina');
  });

  it('accepts /reel/ URLs and canonicalises to /p/', async () => {
    const html = IG_OG_HTML('caption', 'https://cdn/x.jpg', 'A on Instagram: "x"');
    global.fetch = scriptedFetch([
      {
        match: (url) => url === 'https://www.instagram.com/p/REEL01/',
        response: () =>
          new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }),
      },
    ]);
    const resp = await handleFetchPost(
      postJson({ url: 'https://www.instagram.com/reel/REEL01/' }),
      makeEnv(),
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as FetchPostResponse;
    expect(body.permalink).toBe('https://www.instagram.com/p/REEL01/');
  });

  it('returns 502 fetch-failed when og tags are missing entirely', async () => {
    global.fetch = scriptedFetch([
      {
        match: (url) => url.includes('instagram.com'),
        response: () =>
          new Response('<html><head></head><body>nothing</body></html>', {
            status: 200,
            headers: { 'content-type': 'text/html' },
          }),
      },
    ]);
    const resp = await handleFetchPost(
      postJson({ url: 'https://www.instagram.com/p/EMPTY/' }),
      makeEnv(),
    );
    expect(resp.status).toBe(502);
    const body = (await resp.json()) as { error: string };
    expect(body.error).toBe('fetch-failed');
  });

  it('returns 404 not-found on a 404 upstream', async () => {
    global.fetch = scriptedFetch([
      {
        match: (url) => url.includes('instagram.com'),
        response: () => new Response('', { status: 404 }),
      },
    ]);
    const resp = await handleFetchPost(
      postJson({ url: 'https://www.instagram.com/p/MISSING/' }),
      // Even without Apify env, the og: 404 must propagate (not get masked
      // by the Apify-fallback path). Tests the "og error is authoritative
      // when both fail" branch.
      makeEnv(),
    );
    expect(resp.status).toBe(404);
    expect(((await resp.json()) as { error: string }).error).toBe('not-found');
  });

  it('error responses include Cache-Control: no-store', async () => {
    global.fetch = scriptedFetch([
      {
        match: (url) => url.includes('instagram.com'),
        response: () => new Response('', { status: 404 }),
      },
    ]);
    const resp = await handleFetchPost(
      postJson({ url: 'https://www.instagram.com/p/MISSING/' }),
      makeEnv(),
    );
    expect(resp.headers.get('cache-control')).toBe('no-store');
  });

  describe('dispatch (efg decode + Apify integration)', () => {
    function apifySuccess(items: Array<Record<string, unknown>>) {
      return new Response(JSON.stringify(items), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    function envWithApify() {
      return makeEnv({
        APIFY_TOKEN: 'tok',
        APIFY_ACTOR_ID: 'apify~instagram-post-scraper',
      });
    }

    it('routes /p/ + efg=CAROUSEL_ITEM to Apify, discards og:', async () => {
      const html = IG_OG_HTML(
        'og caption — should be replaced',
        IG_COVER_CAROUSEL,
        'X on Instagram: "x"',
      );
      let apifyCalled = false;
      global.fetch = scriptedFetch([
        {
          match: (url) => url === 'https://www.instagram.com/p/CAR1/',
          response: () =>
            new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }),
        },
        {
          match: (url) => url.includes('api.apify.com'),
          response: () => {
            apifyCalled = true;
            return apifySuccess([
              {
                url: 'https://www.instagram.com/p/CAR1/',
                caption: 'apify caption',
                displayUrl: 'https://cdn/cover.jpg',
                childPosts: [
                  { displayUrl: 'https://cdn/s2.jpg' },
                  { displayUrl: 'https://cdn/s3.jpg' },
                ],
                ownerUsername: 'creator',
              },
            ]);
          },
        },
      ]);

      const resp = await handleFetchPost(
        postJson({ url: 'https://www.instagram.com/p/CAR1/' }),
        envWithApify(),
      );
      expect(resp.status).toBe(200);
      expect(apifyCalled).toBe(true);
      const body = (await resp.json()) as FetchPostResponse;
      // Apify is authoritative: caption + imageUrls come from Apify, not og:.
      expect(body.caption).toBe('apify caption');
      expect(body.imageUrls).toEqual([
        'https://cdn/cover.jpg',
        'https://cdn/s2.jpg',
        'https://cdn/s3.jpg',
      ]);
      expect(body.author).toBe('@creator');
      // 7d cache for Apify-backed responses.
      expect(resp.headers.get('cache-control')).toContain('s-maxage=604800');
    });

    it('routes /p/ + efg=single to og: only, never calls Apify', async () => {
      const html = IG_OG_HTML('og caption', IG_COVER_SINGLE, 'X on Instagram: "x"');
      let apifyCalled = false;
      global.fetch = scriptedFetch([
        {
          match: (url) => url === 'https://www.instagram.com/p/S1/',
          response: () =>
            new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }),
        },
        {
          match: (url) => url.includes('api.apify.com'),
          response: () => {
            apifyCalled = true;
            return new Response('[]', { status: 200 });
          },
        },
      ]);

      const resp = await handleFetchPost(
        postJson({ url: 'https://www.instagram.com/p/S1/' }),
        envWithApify(),
      );
      expect(resp.status).toBe(200);
      expect(apifyCalled).toBe(false);
      expect(resp.headers.get('cache-control')).toContain('s-maxage=86400');
    });

    it('routes /p/ with unknown / missing efg to Apify (spec default)', async () => {
      // og:image has no efg query param at all → unknown → fire Apify.
      const html = IG_OG_HTML('og caption', 'https://cdn/no-efg.jpg', 'X on Instagram: "x"');
      let apifyCalled = false;
      global.fetch = scriptedFetch([
        {
          match: (url) => url === 'https://www.instagram.com/p/UNK/',
          response: () =>
            new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }),
        },
        {
          match: (url) => url.includes('api.apify.com'),
          response: () => {
            apifyCalled = true;
            return apifySuccess([
              {
                url: 'https://www.instagram.com/p/UNK/',
                caption: 'apify',
                displayUrl: 'https://cdn/x.jpg',
                ownerUsername: 'u',
              },
            ]);
          },
        },
      ]);

      const resp = await handleFetchPost(
        postJson({ url: 'https://www.instagram.com/p/UNK/' }),
        envWithApify(),
      );
      expect(resp.status).toBe(200);
      expect(apifyCalled).toBe(true);
    });

    it('og: failed + Apify success → returns Apify response', async () => {
      let apifyCalled = false;
      global.fetch = scriptedFetch([
        {
          match: (url) => url === 'https://www.instagram.com/p/FAIL/',
          response: () =>
            new Response('<html><head></head></html>', {
              status: 200,
              headers: { 'content-type': 'text/html' },
            }),
        },
        {
          match: (url) => url.includes('api.apify.com'),
          response: () => {
            apifyCalled = true;
            return apifySuccess([
              {
                url: 'https://www.instagram.com/p/FAIL/',
                caption: 'rescued',
                displayUrl: 'https://cdn/x.jpg',
                ownerUsername: 'u',
              },
            ]);
          },
        },
      ]);

      const resp = await handleFetchPost(
        postJson({ url: 'https://www.instagram.com/p/FAIL/' }),
        envWithApify(),
      );
      expect(resp.status).toBe(200);
      expect(apifyCalled).toBe(true);
      const body = (await resp.json()) as FetchPostResponse;
      expect(body.caption).toBe('rescued');
    });

    it('og:-ok carousel + Apify-fails → 502 fetch-failed (no graceful degrade)', async () => {
      const html = IG_OG_HTML('og caption', IG_COVER_CAROUSEL, 'X on Instagram: "x"');
      global.fetch = scriptedFetch([
        {
          match: (url) => url === 'https://www.instagram.com/p/CAR2/',
          response: () =>
            new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }),
        },
        {
          match: (url) => url.includes('api.apify.com'),
          response: () => new Response('', { status: 503 }),
        },
      ]);

      const resp = await handleFetchPost(
        postJson({ url: 'https://www.instagram.com/p/CAR2/' }),
        envWithApify(),
      );
      expect(resp.status).toBe(502);
      expect(((await resp.json()) as { error: string }).error).toBe('fetch-failed');
      expect(resp.headers.get('cache-control')).toBe('no-store');
    });

    describe('soft-degrade when Apify is not configured', () => {
      it('carousel post: returns og: result instead of calling Apify', async () => {
        const html = IG_OG_HTML('og caption', IG_COVER_CAROUSEL, 'X on Instagram');
        let apifyCalled = false;
        global.fetch = scriptedFetch([
          {
            match: (url) => url === 'https://www.instagram.com/p/CAR/',
            response: () =>
              new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }),
          },
          {
            match: (url) => url.includes('api.apify.com'),
            response: () => {
              apifyCalled = true;
              return new Response('[]', { status: 200 });
            },
          },
        ]);

        // makeEnv() leaves APIFY_TOKEN / APIFY_ACTOR_ID unset.
        const resp = await handleFetchPost(
          postJson({ url: 'https://www.instagram.com/p/CAR/' }),
          makeEnv(),
        );
        expect(resp.status).toBe(200);
        expect(apifyCalled).toBe(false);
        const body = (await resp.json()) as FetchPostResponse;
        // Carousel collapses to slide-1 cover + caption — v0.2.1 behavior.
        expect(body.caption).toBe('og caption');
        expect(body.imageUrls).toEqual([IG_COVER_CAROUSEL]);
        // Cache 1d (og:-only path), not 7d.
        expect(resp.headers.get('cache-control')).toContain('s-maxage=86400');
      });

      it('unknown efg: returns og: result instead of calling Apify', async () => {
        const html = IG_OG_HTML('cap', 'https://cdn/no-efg.jpg', 'X on Instagram');
        let apifyCalled = false;
        global.fetch = scriptedFetch([
          {
            match: (url) => url === 'https://www.instagram.com/p/UNK/',
            response: () =>
              new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }),
          },
          {
            match: (url) => url.includes('api.apify.com'),
            response: () => {
              apifyCalled = true;
              return new Response('[]', { status: 200 });
            },
          },
        ]);
        const resp = await handleFetchPost(
          postJson({ url: 'https://www.instagram.com/p/UNK/' }),
          makeEnv(),
        );
        expect(resp.status).toBe(200);
        expect(apifyCalled).toBe(false);
      });

      it('og:-failed with no Apify: surfaces the og: error (502)', async () => {
        global.fetch = scriptedFetch([
          {
            match: (url) => url === 'https://www.instagram.com/p/X/',
            response: () =>
              new Response('<html><head></head></html>', {
                status: 200,
                headers: { 'content-type': 'text/html' },
              }),
          },
        ]);
        const resp = await handleFetchPost(
          postJson({ url: 'https://www.instagram.com/p/X/' }),
          makeEnv(),
        );
        expect(resp.status).toBe(502);
      });

      it('partial config (token but no actor id) is still degraded', async () => {
        const html = IG_OG_HTML('cap', IG_COVER_CAROUSEL, 'X on Instagram');
        let apifyCalled = false;
        global.fetch = scriptedFetch([
          {
            match: (url) => url === 'https://www.instagram.com/p/CAR/',
            response: () =>
              new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }),
          },
          {
            match: (url) => url.includes('api.apify.com'),
            response: () => {
              apifyCalled = true;
              return new Response('[]', { status: 200 });
            },
          },
        ]);
        const resp = await handleFetchPost(
          postJson({ url: 'https://www.instagram.com/p/CAR/' }),
          makeEnv({ APIFY_TOKEN: 'tok' }), // no APIFY_ACTOR_ID
        );
        expect(resp.status).toBe(200);
        expect(apifyCalled).toBe(false);
      });
    });

    it('/reel/ URLs never go to Apify, even on success', async () => {
      const html = IG_OG_HTML('reel caption', IG_COVER_CAROUSEL, 'X on Instagram');
      let apifyCalled = false;
      global.fetch = scriptedFetch([
        {
          match: (url) => url === 'https://www.instagram.com/p/REEL/',
          response: () =>
            new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }),
        },
        {
          match: (url) => url.includes('api.apify.com'),
          response: () => {
            apifyCalled = true;
            return new Response('[]', { status: 200 });
          },
        },
      ]);
      const resp = await handleFetchPost(
        postJson({ url: 'https://www.instagram.com/reel/REEL/' }),
        envWithApify(),
      );
      expect(resp.status).toBe(200);
      expect(apifyCalled).toBe(false);
    });

    it('exposes og:video and og:video:duration on /reel/ responses (so video extraction can fire without Apify)', async () => {
      // /reel/ URLs short-circuit the chain before Apify, so the og parse is
      // the only place to surface videoUrl. The IG HTML for a Reel always
      // includes og:video* meta tags pointing at the MP4 CDN URL.
      const html = `<html><head>
          <meta property="og:title" content="Foodie on Instagram" />
          <meta property="og:description" content="Best ramen in Shibuya" />
          <meta property="og:image" content="${IG_COVER_CAROUSEL}" />
          <meta property="og:video:secure_url" content="https://cdn/reel.mp4" />
          <meta property="og:video" content="https://cdn/reel-legacy.mp4" />
          <meta property="og:video:duration" content="28" />
        </head></html>`;
      global.fetch = scriptedFetch([
        {
          match: (url) => url === 'https://www.instagram.com/p/REEL2/',
          response: () =>
            new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }),
        },
      ]);
      const resp = await handleFetchPost(
        postJson({ url: 'https://www.instagram.com/reel/REEL2/' }),
        envWithApify(),
      );
      expect(resp.status).toBe(200);
      const body = (await resp.json()) as {
        videoUrl?: string;
        videoDuration?: number;
      };
      expect(body.videoUrl).toBe('https://cdn/reel.mp4');
      expect(body.videoDuration).toBe(28);
    });

    it('og:video duration is null when missing or malformed', async () => {
      const html = `<html><head>
          <meta property="og:title" content="X" />
          <meta property="og:description" content="caption" />
          <meta property="og:image" content="${IG_COVER_CAROUSEL}" />
          <meta property="og:video" content="https://cdn/reel.mp4" />
        </head></html>`;
      global.fetch = scriptedFetch([
        {
          match: (url) => url === 'https://www.instagram.com/p/REEL3/',
          response: () =>
            new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }),
        },
      ]);
      const resp = await handleFetchPost(
        postJson({ url: 'https://www.instagram.com/reel/REEL3/' }),
        envWithApify(),
      );
      expect(resp.status).toBe(200);
      const body = (await resp.json()) as { videoUrl?: string; videoDuration?: number | null };
      expect(body.videoUrl).toBe('https://cdn/reel.mp4');
      expect(body.videoDuration ?? null).toBeNull();
    });
  });
});

describe('handleFetchPost — TikTok', () => {
  it('extracts all slides for a /photo/ URL via the rehydration parser', async () => {
    const html = ttRehydHtml({
      desc: '5 cafes in Tokyo',
      author: { uniqueId: 'foodietravels' },
      imagePost: {
        images: [
          { imageURL: { urlList: ['https://p16/1.jpg'] } },
          { imageURL: { urlList: ['https://p16/2.jpg'] } },
          { imageURL: { urlList: ['https://p16/3.jpg'] } },
        ],
      },
      video: { cover: 'https://p16/c.jpg' }, // ignored when imagePost present
    });
    global.fetch = scriptedFetch([
      {
        match: (url) => url === 'https://www.tiktok.com/@foodietravels/photo/123',
        response: () =>
          new Response(html, {
            status: 200,
            headers: { 'content-type': 'text/html' },
          }),
      },
    ]);
    const resp = await handleFetchPost(
      postJson({ url: 'https://www.tiktok.com/@foodietravels/photo/123' }),
      makeEnv(),
    );
    expect(resp.status).toBe(200);
    expect(resp.headers.get('cache-control')).toContain('s-maxage=86400');
    const body = (await resp.json()) as FetchPostResponse;
    expect(body.platform).toBe('tiktok');
    expect(body.caption).toBe('5 cafes in Tokyo');
    expect(body.author).toBe('@foodietravels');
    expect(body.imageUrls).toEqual(['https://p16/1.jpg', 'https://p16/2.jpg', 'https://p16/3.jpg']);
  });

  it('returns the video cover for a /video/ URL via the rehydration parser', async () => {
    const html = ttRehydHtml({
      desc: 'video caption',
      author: { uniqueId: 'foo' },
      video: { cover: 'https://p16/cover.jpg' },
    });
    global.fetch = scriptedFetch([
      {
        match: (url) => url === 'https://www.tiktok.com/@foo/video/9',
        response: () =>
          new Response(html, {
            status: 200,
            headers: { 'content-type': 'text/html' },
          }),
      },
    ]);
    const resp = await handleFetchPost(
      postJson({ url: 'https://www.tiktok.com/@foo/video/9' }),
      makeEnv(),
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as FetchPostResponse;
    expect(body.imageUrls).toEqual(['https://p16/cover.jpg']);
    expect(body.author).toBe('@foo');
  });

  it('falls back to oEmbed when the page is an anti-bot stub (no rehydration JSON)', async () => {
    global.fetch = scriptedFetch([
      {
        match: (url) => url === 'https://www.tiktok.com/@foo/video/9',
        response: () =>
          new Response('<html><head></head></html>', {
            status: 200,
            headers: { 'content-type': 'text/html' },
          }),
      },
      {
        match: (url) => url.startsWith('https://www.tiktok.com/oembed?'),
        response: () =>
          new Response(
            JSON.stringify({
              title: 'oembed caption',
              thumbnail_url: 'https://p16-sign.tiktokcdn.com/thumb.jpg',
              author_name: 'foo',
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
      },
    ]);
    const resp = await handleFetchPost(
      postJson({ url: 'https://www.tiktok.com/@foo/video/9' }),
      makeEnv(),
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as FetchPostResponse;
    expect(body.caption).toBe('oembed caption');
    expect(body.imageUrls[0]).toContain('thumb.jpg');
    expect(body.author).toBe('@foo');
  });

  it('returns 502 fetch-failed when both rehydration parse and oEmbed fail', async () => {
    global.fetch = scriptedFetch([
      {
        match: (url) => url === 'https://www.tiktok.com/@foo/video/9',
        response: () =>
          new Response('<html></html>', {
            status: 200,
            headers: { 'content-type': 'text/html' },
          }),
      },
      {
        match: (url) => url.startsWith('https://www.tiktok.com/oembed?'),
        response: () => new Response('', { status: 500 }),
      },
    ]);
    const resp = await handleFetchPost(
      postJson({ url: 'https://www.tiktok.com/@foo/video/9' }),
      makeEnv(),
    );
    expect(resp.status).toBe(502);
    expect(resp.headers.get('cache-control')).toBe('no-store');
    expect(((await resp.json()) as { error: string }).error).toBe('fetch-failed');
  });
});

describe('handleFetchPost — _debug echo', () => {
  // Mirrors the dispatch matrix in the spec §Worker debug echo. Each branch
  // returns a specific `route` so the phone can render the chosen path in
  // the pipeline firehose without a `wrangler tail` round-trip.

  function apifySuccess(items: Array<Record<string, unknown>>) {
    return new Response(JSON.stringify(items), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  function envWithApify() {
    return makeEnv({
      APIFY_TOKEN: 'tok',
      APIFY_ACTOR_ID: 'apify~instagram-post-scraper',
    });
  }

  async function debugOf(req: Request, env: Env) {
    const resp = await handleFetchPost(req, env);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as FetchPostResponse;
    expect(body._debug).toBeDefined();
    return body._debug!;
  }

  it('og_only — /p/ + efg=single', async () => {
    const html = IG_OG_HTML('cap', IG_COVER_SINGLE, 'X on Instagram');
    global.fetch = scriptedFetch([
      {
        match: (url) => url === 'https://www.instagram.com/p/S/',
        response: () =>
          new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }),
      },
    ]);
    const dbg = await debugOf(postJson({ url: 'https://www.instagram.com/p/S/' }), envWithApify());
    expect(dbg.route).toBe('og_only');
    expect(dbg.ogOutcome).toBe('ok');
    expect(dbg.apifyOutcome).toBe('not_called');
    expect(dbg.cacheHit).toBe(false);
  });

  it('og_only — /reel/ short-circuits before Apify', async () => {
    const html = IG_OG_HTML('cap', IG_COVER_CAROUSEL, 'X on Instagram');
    global.fetch = scriptedFetch([
      {
        match: (url) => url === 'https://www.instagram.com/p/R/',
        response: () =>
          new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }),
      },
    ]);
    const dbg = await debugOf(
      postJson({ url: 'https://www.instagram.com/reel/R/' }),
      envWithApify(),
    );
    expect(dbg.route).toBe('og_only');
    expect(dbg.apifyOutcome).toBe('not_called');
  });

  it('og_then_apify_carousel — efg=carousel, Apify success', async () => {
    const html = IG_OG_HTML('og', IG_COVER_CAROUSEL, 'X on Instagram');
    global.fetch = scriptedFetch([
      {
        match: (url) => url === 'https://www.instagram.com/p/C/',
        response: () =>
          new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }),
      },
      {
        match: (url) => url.includes('api.apify.com'),
        response: () =>
          apifySuccess([
            {
              url: 'https://www.instagram.com/p/C/',
              caption: 'apify',
              displayUrl: 'https://cdn/c.jpg',
              ownerUsername: 'u',
            },
          ]),
      },
    ]);
    const dbg = await debugOf(postJson({ url: 'https://www.instagram.com/p/C/' }), envWithApify());
    expect(dbg.route).toBe('og_then_apify_carousel');
    expect(dbg.ogOutcome).toBe('ok');
    expect(dbg.apifyOutcome).toBe('ok');
  });

  it('og_then_apify_unknown_efg — no efg query param', async () => {
    const html = IG_OG_HTML('og', 'https://cdn/no-efg.jpg', 'X on Instagram');
    global.fetch = scriptedFetch([
      {
        match: (url) => url === 'https://www.instagram.com/p/U/',
        response: () =>
          new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }),
      },
      {
        match: (url) => url.includes('api.apify.com'),
        response: () =>
          apifySuccess([
            {
              url: 'https://www.instagram.com/p/U/',
              caption: 'apify',
              displayUrl: 'https://cdn/u.jpg',
              ownerUsername: 'u',
            },
          ]),
      },
    ]);
    const dbg = await debugOf(postJson({ url: 'https://www.instagram.com/p/U/' }), envWithApify());
    expect(dbg.route).toBe('og_then_apify_unknown_efg');
  });

  it('og_failed_apify_fallback — og empty, Apify success', async () => {
    global.fetch = scriptedFetch([
      {
        match: (url) => url === 'https://www.instagram.com/p/F/',
        response: () =>
          new Response('<html><head></head></html>', {
            status: 200,
            headers: { 'content-type': 'text/html' },
          }),
      },
      {
        match: (url) => url.includes('api.apify.com'),
        response: () =>
          apifySuccess([
            {
              url: 'https://www.instagram.com/p/F/',
              caption: 'rescued',
              displayUrl: 'https://cdn/f.jpg',
              ownerUsername: 'u',
            },
          ]),
      },
    ]);
    const dbg = await debugOf(postJson({ url: 'https://www.instagram.com/p/F/' }), envWithApify());
    expect(dbg.route).toBe('og_failed_apify_fallback');
    // og:-failed surfaces in ogOutcome with the closed-vocab class for the
    // upstream error (502 fetch-failed → upstream_5xx).
    expect(dbg.ogOutcome).toBe('upstream_5xx');
    expect(dbg.apifyOutcome).toBe('ok');
  });

  it('og_only_apify_disabled — soft-degrade when Apify env unset', async () => {
    const html = IG_OG_HTML('og', IG_COVER_CAROUSEL, 'X on Instagram');
    global.fetch = scriptedFetch([
      {
        match: (url) => url === 'https://www.instagram.com/p/D/',
        response: () =>
          new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }),
      },
    ]);
    const dbg = await debugOf(
      postJson({ url: 'https://www.instagram.com/p/D/' }),
      makeEnv(), // no APIFY_TOKEN / APIFY_ACTOR_ID
    );
    expect(dbg.route).toBe('og_only_apify_disabled');
    expect(dbg.ogOutcome).toBe('ok');
    expect(dbg.apifyOutcome).toBe('not_configured');
  });

  it('tiktok_rehyd_photo — photo post extracted via rehydration', async () => {
    const html = ttRehydHtml({
      desc: 'x',
      author: { uniqueId: 'u' },
      imagePost: { images: [{ imageURL: { urlList: ['https://cdn/a.jpg'] } }] },
    });
    global.fetch = scriptedFetch([
      {
        match: (url) => url === 'https://www.tiktok.com/@u/photo/1',
        response: () =>
          new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }),
      },
    ]);
    const dbg = await debugOf(postJson({ url: 'https://www.tiktok.com/@u/photo/1' }), makeEnv());
    expect(dbg.route).toBe('tiktok_rehyd_photo');
    expect(dbg.ogOutcome).toBe('ok');
    expect(dbg.apifyOutcome).toBe('not_called');
  });

  it('tiktok_rehyd_video — video post extracted via rehydration', async () => {
    const html = ttRehydHtml({
      desc: 'x',
      author: { uniqueId: 'u' },
      video: { cover: 'https://cdn/c.jpg' },
    });
    global.fetch = scriptedFetch([
      {
        match: (url) => url === 'https://www.tiktok.com/@u/video/1',
        response: () =>
          new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }),
      },
    ]);
    const dbg = await debugOf(postJson({ url: 'https://www.tiktok.com/@u/video/1' }), makeEnv());
    expect(dbg.route).toBe('tiktok_rehyd_video');
    expect(dbg.ogOutcome).toBe('ok');
  });

  it('tiktok_oembed_fallback — anti-bot stub, oEmbed picks up', async () => {
    global.fetch = scriptedFetch([
      {
        match: (url) => url === 'https://www.tiktok.com/@foo/video/2',
        response: () =>
          new Response('<html><head></head></html>', {
            status: 200,
            headers: { 'content-type': 'text/html' },
          }),
      },
      {
        match: (url) => url.startsWith('https://www.tiktok.com/oembed?'),
        response: () =>
          new Response(
            JSON.stringify({
              title: 't',
              thumbnail_url: 'https://p16/t.jpg',
              author_name: 'foo',
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
      },
    ]);
    const dbg = await debugOf(postJson({ url: 'https://www.tiktok.com/@foo/video/2' }), makeEnv());
    expect(dbg.route).toBe('tiktok_oembed_fallback');
    expect(dbg.ogOutcome).toBe('empty');
  });
});

describe('handleFetchPost — guards', () => {
  it('rejects non-IG/TikTok URLs with 400 unsupported-url', async () => {
    // Provide RC mock so entitlement passes; verify no IG/TikTok/Apify fetch
    // was triggered for an unsupported URL.
    const fetchSpy = scriptedFetch([]); // only RC matcher; all others throw
    global.fetch = fetchSpy;
    const resp = await handleFetchPost(
      postJson({ url: 'https://www.youtube.com/watch?v=abc' }),
      makeEnv(),
    );
    expect(resp.status).toBe(400);
    expect(((await resp.json()) as { error: string }).error).toBe('unsupported-url');
    // Only the RC entitlement check should have been called — no IG/TikTok fetches.
    const calls = (fetchSpy as unknown as jest.Mock).mock.calls as Array<[unknown]>;
    const nonRcCalls = calls.filter((c) => !String(c[0]).startsWith('https://api.revenuecat.com/'));
    expect(nonRcCalls).toHaveLength(0);
  });

  it('honours rate-limit gate with 429', async () => {
    const env = makeEnv({
      RATE_LIMIT: rateLimit(false) as unknown as Env['RATE_LIMIT'],
    });
    const resp = await handleFetchPost(postJson({ url: 'https://www.instagram.com/p/X/' }), env);
    expect(resp.status).toBe(429);
  });

  it('rejects non-POST methods', async () => {
    const req = new Request('https://proxy.example.com/fetch-post', { method: 'GET' });
    const resp = await handleFetchPost(req, makeEnv());
    expect(resp.status).toBe(405);
  });

  it('rejects invalid JSON body', async () => {
    const req = new Request('https://proxy.example.com/fetch-post', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-RC-User-Id': VALID_ID },
      body: 'not-json',
    });
    const resp = await handleFetchPost(req, makeEnv());
    expect(resp.status).toBe(400);
  });

  it('rejects missing url field', async () => {
    const resp = await handleFetchPost(postJson({}), makeEnv());
    expect(resp.status).toBe(400);
  });

  test('returns 401 missing-user-id when X-RC-User-Id header is absent', async () => {
    const env = makeEnv();
    const req = new Request('https://proxy.example.com/fetch-post', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://www.instagram.com/p/ABC123/' }),
    });
    const res = await handleFetchPost(req, env);
    expect(res.status).toBe(401);
    expect(await res.clone().json()).toEqual({ error: 'missing-user-id' });
  });
});
