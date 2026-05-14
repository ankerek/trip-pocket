import { ApifyError, fetchInstagramViaApify, mapApifyItem } from '../src/apify';

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

describe('mapApifyItem', () => {
  it('maps a single-image post', () => {
    const out = mapApifyItem(
      {
        url: 'https://www.instagram.com/p/ABC/',
        caption: 'hello',
        displayUrl: 'https://cdn/a.jpg',
        ownerUsername: 'foo',
        type: 'Image',
      },
      'https://www.instagram.com/p/ABC/',
    );
    expect(out.caption).toBe('hello');
    expect(out.imageUrls).toEqual(['https://cdn/a.jpg']);
    expect(out.author).toBe('@foo');
  });

  it('flattens childPosts into imageUrls after the cover', () => {
    const out = mapApifyItem(
      {
        url: 'https://www.instagram.com/p/CAR/',
        caption: 'slides',
        displayUrl: 'https://cdn/cover.jpg',
        childPosts: [{ displayUrl: 'https://cdn/s2.jpg' }, { displayUrl: 'https://cdn/s3.jpg' }],
        ownerUsername: 'creator',
        type: 'Sidecar',
      },
      'https://www.instagram.com/p/CAR/',
    );
    expect(out.imageUrls).toEqual([
      'https://cdn/cover.jpg',
      'https://cdn/s2.jpg',
      'https://cdn/s3.jpg',
    ]);
  });

  it('drops empty childPost entries', () => {
    const out = mapApifyItem(
      {
        displayUrl: 'https://cdn/cover.jpg',
        childPosts: [{ displayUrl: '' }, { displayUrl: 'https://cdn/s.jpg' }],
      },
      'https://fallback/',
    );
    expect(out.imageUrls).toEqual(['https://cdn/cover.jpg', 'https://cdn/s.jpg']);
  });

  it('falls back to provided permalink when raw.url is missing', () => {
    const out = mapApifyItem({ displayUrl: 'https://cdn/a.jpg' }, 'https://x/p/Q/');
    expect(out.permalink).toBe('https://x/p/Q/');
  });

  it('returns null author when ownerUsername is missing or empty', () => {
    expect(mapApifyItem({ displayUrl: 'x' }, 'p').author).toBeNull();
    expect(mapApifyItem({ displayUrl: 'x', ownerUsername: '' }, 'p').author).toBeNull();
  });

  it('coerces missing caption to empty string', () => {
    expect(mapApifyItem({ displayUrl: 'x' }, 'p').caption).toBe('');
    expect(mapApifyItem({ displayUrl: 'x', caption: null }, 'p').caption).toBe('');
  });
});

describe('fetchInstagramViaApify', () => {
  const opts = { token: 'tok', actorId: 'apify~instagram-post-scraper' };

  it('POSTs run-sync-get-dataset-items with username (URL) and parses the result', async () => {
    let captured: { url: string; init?: RequestInit } | null = null;
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      captured = {
        url: typeof input === 'string' ? input : input.toString(),
        init,
      };
      return new Response(
        JSON.stringify([
          {
            url: 'https://www.instagram.com/p/ABC/',
            caption: 'hello',
            displayUrl: 'https://cdn/cover.jpg',
            childPosts: [{ displayUrl: 'https://cdn/s2.jpg' }],
            ownerUsername: 'foo',
            type: 'Sidecar',
          },
        ]),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const out = await fetchInstagramViaApify('https://www.instagram.com/p/ABC/', opts);
    expect(out.caption).toBe('hello');
    expect(out.imageUrls).toEqual(['https://cdn/cover.jpg', 'https://cdn/s2.jpg']);
    expect(out.author).toBe('@foo');

    const c = captured as unknown as { url: string; init: RequestInit };
    expect(c.url).toContain('api.apify.com');
    expect(c.url).toContain('/v2/acts/apify~instagram-post-scraper/run-sync-get-dataset-items');
    expect(c.url).toContain('token=tok');
    const body = JSON.parse(c.init.body as string) as {
      username: string[];
      resultsLimit: number;
    };
    expect(body.username).toEqual(['https://www.instagram.com/p/ABC/']);
    expect(body.resultsLimit).toBe(1);
  });

  it('throws apify-empty when the actor returns an empty array', async () => {
    global.fetch = scriptedFetch([
      {
        match: () => true,
        response: () =>
          new Response('[]', {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      },
    ]);
    await expect(
      fetchInstagramViaApify('https://www.instagram.com/p/X/', opts),
    ).rejects.toMatchObject({ code: 'apify-empty' });
  });

  it('throws apify-auth on 401 / 403', async () => {
    global.fetch = scriptedFetch([
      { match: () => true, response: () => new Response('', { status: 401 }) },
    ]);
    await expect(
      fetchInstagramViaApify('https://www.instagram.com/p/X/', opts),
    ).rejects.toMatchObject({ code: 'apify-auth' });
  });

  it('throws apify-rate-limited on 429', async () => {
    global.fetch = scriptedFetch([
      { match: () => true, response: () => new Response('', { status: 429 }) },
    ]);
    await expect(
      fetchInstagramViaApify('https://www.instagram.com/p/X/', opts),
    ).rejects.toMatchObject({ code: 'apify-rate-limited' });
  });

  it('throws apify-upstream on a generic 5xx', async () => {
    global.fetch = scriptedFetch([
      { match: () => true, response: () => new Response('', { status: 503 }) },
    ]);
    await expect(
      fetchInstagramViaApify('https://www.instagram.com/p/X/', opts),
    ).rejects.toMatchObject({ code: 'apify-upstream' });
  });

  it('throws apify-not-configured when token or actorId is empty', async () => {
    await expect(
      fetchInstagramViaApify('https://x/p/Q/', { token: '', actorId: 'a' }),
    ).rejects.toMatchObject({ code: 'apify-not-configured' });
    await expect(
      fetchInstagramViaApify('https://x/p/Q/', { token: 't', actorId: '' }),
    ).rejects.toMatchObject({ code: 'apify-not-configured' });
  });
});

// Sanity check that the exported error class is recognisable downstream.
describe('ApifyError', () => {
  it('carries status + code', () => {
    const e = new ApifyError(502, 'apify-empty');
    expect(e.status).toBe(502);
    expect(e.code).toBe('apify-empty');
    expect(e.name).toBe('ApifyError');
  });
});
