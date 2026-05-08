import { handlePhoto } from '../src/photo';
import type { Env } from '../src/index';

function rateLimit(allowed = true) {
  return { limit: jest.fn(async () => ({ success: allowed })) };
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    GEMINI_API_KEY: 'gemini-key',
    GOOGLE_PLACES_API_KEY: 'places-key',
    CF_ACCOUNT_ID: 'acct',
    AI_GATEWAY_NAME: 'default',
    CF_AIG_TOKEN: 'aig-token',
    RATE_LIMIT: rateLimit(true) as unknown as Env['RATE_LIMIT'],
    ...overrides,
  };
}

function get(path: string): Request {
  return new Request(`https://proxy.example.com${path}`, {
    method: 'GET',
    headers: { 'CF-Connecting-IP': '1.2.3.4' },
  });
}

const photoBody = new Uint8Array([0xff, 0xd8, 0xff]); // JPEG magic

function googlePhotoOk() {
  return new Response(photoBody, {
    status: 200,
    headers: { 'content-type': 'image/jpeg', 'content-length': '3' },
  });
}

describe('handlePhoto', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns 405 for non-GET methods', async () => {
    const req = new Request('https://proxy.example.com/photo/places/abc/photos/xyz', {
      method: 'POST',
    });
    const res = await handlePhoto(req, makeEnv());
    expect(res.status).toBe(405);
  });

  it('returns 400 when path is just /photo/ (no name)', async () => {
    const res = await handlePhoto(get('/photo/'), makeEnv());
    expect(res.status).toBe(400);
  });

  it('returns 400 for an invalid photo name shape (missing /photos/ segment)', async () => {
    const res = await handlePhoto(get('/photo/places/abc'), makeEnv());
    expect(res.status).toBe(400);
  });

  it('returns 400 for path traversal attempt', async () => {
    const res = await handlePhoto(get('/photo/places/abc/photos/..%2Fevil'), makeEnv());
    expect(res.status).toBe(400);
  });

  it('returns 429 when rate limit denies', async () => {
    const env = makeEnv({ RATE_LIMIT: rateLimit(false) as unknown as Env['RATE_LIMIT'] });
    const res = await handlePhoto(get('/photo/places/abc/photos/xyz'), env);
    expect(res.status).toBe(429);
  });

  it('returns 500 when GOOGLE_PLACES_API_KEY is missing', async () => {
    const res = await handlePhoto(
      get('/photo/places/abc/photos/xyz'),
      makeEnv({ GOOGLE_PLACES_API_KEY: '' }),
    );
    expect(res.status).toBe(500);
  });

  // --- happy path ---

  it('proxies the photo body and sets a 30-day cache header', async () => {
    globalThis.fetch = jest.fn(async () => googlePhotoOk()) as unknown as typeof fetch;
    const res = await handlePhoto(get('/photo/places/abc/photos/xyz'), makeEnv());

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(res.headers.get('cache-control')).toBe('public, max-age=2592000, immutable');
    const buf = new Uint8Array(await res.arrayBuffer());
    expect(buf).toEqual(photoBody);
  });

  it('sends the API key to upstream, but never returns it to the client', async () => {
    const fetchSpy = jest.fn(async () => googlePhotoOk()) as unknown as typeof fetch;
    globalThis.fetch = fetchSpy;

    const res = await handlePhoto(get('/photo/places/abc/photos/xyz?w=400&h=300'), makeEnv());
    const upstreamUrl = (fetchSpy as unknown as jest.Mock).mock.calls[0][0] as string;
    expect(upstreamUrl).toContain('https://places.googleapis.com/v1/places/abc/photos/xyz/media');
    expect(upstreamUrl).toContain('key=places-key');
    expect(upstreamUrl).toContain('maxWidthPx=400');
    expect(upstreamUrl).toContain('maxHeightPx=300');

    // Response headers must not contain the key.
    for (const [k, v] of res.headers.entries()) {
      expect(`${k}: ${v}`).not.toContain('places-key');
    }
  });

  it('clamps oversized w/h params to MAX_DIMENSION (4800)', async () => {
    const fetchSpy = jest.fn(async () => googlePhotoOk()) as unknown as typeof fetch;
    globalThis.fetch = fetchSpy;

    await handlePhoto(get('/photo/places/abc/photos/xyz?w=99999&h=99999'), makeEnv());
    const upstreamUrl = (fetchSpy as unknown as jest.Mock).mock.calls[0][0] as string;
    expect(upstreamUrl).toContain('maxWidthPx=4800');
    expect(upstreamUrl).toContain('maxHeightPx=4800');
  });

  it('uses default dimension (1200) when w/h not provided', async () => {
    const fetchSpy = jest.fn(async () => googlePhotoOk()) as unknown as typeof fetch;
    globalThis.fetch = fetchSpy;

    await handlePhoto(get('/photo/places/abc/photos/xyz'), makeEnv());
    const upstreamUrl = (fetchSpy as unknown as jest.Mock).mock.calls[0][0] as string;
    expect(upstreamUrl).toContain('maxWidthPx=1200');
    expect(upstreamUrl).toContain('maxHeightPx=1200');
  });

  // --- upstream errors ---

  it('returns 404 when Google returns 404', async () => {
    globalThis.fetch = jest.fn(
      async () => new Response('not found', { status: 404 }),
    ) as unknown as typeof fetch;

    const res = await handlePhoto(get('/photo/places/abc/photos/xyz'), makeEnv());
    expect(res.status).toBe(404);
  });

  it('returns 502 when Google returns 5xx', async () => {
    globalThis.fetch = jest.fn(
      async () => new Response('boom', { status: 500 }),
    ) as unknown as typeof fetch;

    const res = await handlePhoto(get('/photo/places/abc/photos/xyz'), makeEnv());
    expect(res.status).toBe(502);
  });

  it('returns 502 on network error', async () => {
    globalThis.fetch = jest.fn(async () => {
      throw new Error('network');
    }) as unknown as typeof fetch;

    const res = await handlePhoto(get('/photo/places/abc/photos/xyz'), makeEnv());
    expect(res.status).toBe(502);
  });
});
