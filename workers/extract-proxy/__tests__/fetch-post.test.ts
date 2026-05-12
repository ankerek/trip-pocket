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
    const html =
      '<meta content="https://cdn/img.jpg" property="og:image" />';
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
  it('extractAuthorFromTikTokUrl reads /@handle/', () => {
    expect(
      extractAuthorFromTikTokUrl(new URL('https://www.tiktok.com/@khaby/video/12')),
    ).toBe('@khaby');
    expect(extractAuthorFromTikTokUrl(new URL('https://www.tiktok.com/'))).toBeNull();
  });
  it('extractAuthorFromTikTokTitle takes prefix before " on TikTok"', () => {
    expect(extractAuthorFromTikTokTitle('Khaby on TikTok: x')).toBe('Khaby');
    expect(extractAuthorFromTikTokTitle(null)).toBeNull();
  });
});

// --- Integration tests for handleFetchPost -------------------------------

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
    ...overrides,
  };
}

function postJson(body: unknown, ip = '1.2.3.4'): Request {
  return new Request('https://proxy.example.com/fetch-post', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'CF-Connecting-IP': ip },
    body: JSON.stringify(body),
  });
}

type FetchScript = Array<{
  match: (url: string, init?: RequestInit) => boolean;
  response: () => Response;
}>;

function scriptedFetch(script: FetchScript) {
  return jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    for (const step of script) {
      if (step.match(url, init)) return step.response();
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;
}

const IG_OG_HTML = (caption: string, image: string, title: string) =>
  `<html><head>
    <meta property="og:title" content="${title}" />
    <meta property="og:description" content="${caption}" />
    <meta property="og:image" content="${image}" />
  </head></html>`;

const TT_OG_HTML = (caption: string, image: string, title: string) =>
  `<html><head>
    <meta property="og:title" content="${title}" />
    <meta property="og:description" content="${caption}" />
    <meta property="og:image" content="${image}" />
  </head></html>`;

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
        match: (url) =>
          url === 'https://www.instagram.com/p/ABC123/',
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
  });
});

describe('handleFetchPost — TikTok', () => {
  it('parses og tags from the canonical URL (primary path)', async () => {
    const html = TT_OG_HTML(
      'best ramen in Tokyo',
      'https://p16-sign.tiktokcdn.com/cover.jpg',
      'foodietravels on TikTok',
    );
    global.fetch = scriptedFetch([
      {
        match: (url) => url === 'https://www.tiktok.com/@foodietravels/video/123',
        response: () =>
          new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }),
      },
    ]);
    const resp = await handleFetchPost(
      postJson({ url: 'https://www.tiktok.com/@foodietravels/video/123' }),
      makeEnv(),
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as FetchPostResponse;
    expect(body.platform).toBe('tiktok');
    expect(body.caption).toBe('best ramen in Tokyo');
    expect(body.imageUrls).toEqual([
      'https://p16-sign.tiktokcdn.com/cover.jpg',
    ]);
    expect(body.author).toBe('@foodietravels');
  });

  it('falls back to oEmbed when og tags are missing', async () => {
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
});

describe('handleFetchPost — guards', () => {
  it('rejects non-IG/TikTok URLs with 400 unsupported-url', async () => {
    global.fetch = jest.fn(); // should never be called
    const resp = await handleFetchPost(
      postJson({ url: 'https://www.youtube.com/watch?v=abc' }),
      makeEnv(),
    );
    expect(resp.status).toBe(400);
    expect(((await resp.json()) as { error: string }).error).toBe('unsupported-url');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('honours rate-limit gate with 429', async () => {
    const env = makeEnv({
      RATE_LIMIT: rateLimit(false) as unknown as Env['RATE_LIMIT'],
    });
    const resp = await handleFetchPost(
      postJson({ url: 'https://www.instagram.com/p/X/' }),
      env,
    );
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
      headers: { 'content-type': 'application/json' },
      body: 'not-json',
    });
    const resp = await handleFetchPost(req, makeEnv());
    expect(resp.status).toBe(400);
  });

  it('rejects missing url field', async () => {
    const resp = await handleFetchPost(postJson({}), makeEnv());
    expect(resp.status).toBe(400);
  });
});
