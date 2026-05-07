import { handleExtract } from '../src/index';
import type { Env } from '../src/index';

// Minimal stub of the Cloudflare Rate Limit binding.
function rateLimit(allowed = true) {
  return {
    limit: jest.fn(async () => ({ success: allowed })),
  };
}

function geminiOkResponse(places: Array<{ name: string; city: string; category: string }>) {
  // Gemini's structure for `responseMimeType: 'application/json'`:
  // candidates[0].content.parts[0].text contains the JSON string.
  return new Response(
    JSON.stringify({
      candidates: [
        {
          content: {
            parts: [{ text: JSON.stringify({ places }) }],
          },
        },
      ],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    GEMINI_API_KEY: 'test-key',
    CF_ACCOUNT_ID: 'test-account',
    AI_GATEWAY_NAME: 'default',
    CF_AIG_TOKEN: 'test-aig-token',
    RATE_LIMIT: rateLimit(true) as unknown as Env['RATE_LIMIT'],
    ...overrides,
  };
}

function postJson(body: unknown): Request {
  return new Request('https://proxy.example.com/extract', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '1.2.3.4' },
    body: JSON.stringify(body),
  });
}

describe('handleExtract', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns 405 for non-POST methods', async () => {
    const req = new Request('https://proxy.example.com/extract', { method: 'GET' });
    const res = await handleExtract(req, makeEnv());
    expect(res.status).toBe(405);
  });

  it('returns 400 when content-type is not application/json', async () => {
    const req = new Request('https://proxy.example.com/extract', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'hi',
    });
    const res = await handleExtract(req, makeEnv());
    expect(res.status).toBe(400);
  });

  it('returns 400 when body is not parseable JSON', async () => {
    const req = new Request('https://proxy.example.com/extract', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });
    const res = await handleExtract(req, makeEnv());
    expect(res.status).toBe(400);
  });

  it('returns 400 when body is missing ocr_text', async () => {
    const res = await handleExtract(postJson({}), makeEnv());
    expect(res.status).toBe(400);
  });

  it('returns 400 when ocr_text is empty', async () => {
    const res = await handleExtract(postJson({ ocr_text: '' }), makeEnv());
    expect(res.status).toBe(400);
  });

  it('returns 429 when rate limit denies', async () => {
    const env = makeEnv({ RATE_LIMIT: rateLimit(false) as unknown as Env['RATE_LIMIT'] });
    const res = await handleExtract(postJson({ ocr_text: 'hello' }), env);
    expect(res.status).toBe(429);
  });

  it('returns 200 with parsed places when Gemini succeeds', async () => {
    globalThis.fetch = jest.fn(async () =>
      geminiOkResponse([
        { name: 'Maru Tonkatsu', city: 'Tokyo', category: 'food' },
        { name: 'Tsukiji Market', city: 'Tokyo', category: 'place' },
      ]),
    ) as unknown as typeof fetch;

    const res = await handleExtract(
      postJson({ ocr_text: 'Maru Tonkatsu in Shibuya. Visit Tsukiji.' }),
      makeEnv(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { places: unknown[]; model: string };
    expect(body.places).toHaveLength(2);
    expect(body.model).toBe('gemini-2.5-flash-lite');
  });

  it('returns 200 with empty places when Gemini classifies as noise', async () => {
    globalThis.fetch = jest.fn(async () => geminiOkResponse([])) as unknown as typeof fetch;
    const res = await handleExtract(postJson({ ocr_text: 'just a meme' }), makeEnv());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { places: unknown[] };
    expect(body.places).toEqual([]);
  });

  it('returns 502 when Gemini returns malformed JSON in candidates[0]', async () => {
    globalThis.fetch = jest.fn(
      async () =>
        new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: '{ "places": [' }] } }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    ) as unknown as typeof fetch;

    const res = await handleExtract(postJson({ ocr_text: 'hi' }), makeEnv());
    expect(res.status).toBe(502);
  });

  it('returns 502 when Gemini response fails Zod validation', async () => {
    globalThis.fetch = jest.fn(async () =>
      geminiOkResponse([{ name: 'X', city: 'Y', category: 'unknown-cat' as 'food' }]),
    ) as unknown as typeof fetch;

    const res = await handleExtract(postJson({ ocr_text: 'hi' }), makeEnv());
    expect(res.status).toBe(502);
  });

  it('returns 502 when Gemini upstream returns 5xx', async () => {
    globalThis.fetch = jest.fn(
      async () => new Response('upstream burning', { status: 500 }),
    ) as unknown as typeof fetch;
    const res = await handleExtract(postJson({ ocr_text: 'hi' }), makeEnv());
    expect(res.status).toBe(502);
  });

  it('passes upstream Retry-After through on 429', async () => {
    globalThis.fetch = jest.fn(
      async () =>
        new Response('rate limited upstream', {
          status: 429,
          headers: { 'retry-after': '42' },
        }),
    ) as unknown as typeof fetch;
    const res = await handleExtract(postJson({ ocr_text: 'hi' }), makeEnv());
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('42');
  });

  it('returns 500 when GEMINI_API_KEY is missing', async () => {
    const env = makeEnv({ GEMINI_API_KEY: '' });
    const res = await handleExtract(postJson({ ocr_text: 'hi' }), env);
    expect(res.status).toBe(500);
  });

  it('does not echo OCR text in any response body', async () => {
    globalThis.fetch = jest.fn(async () => geminiOkResponse([])) as unknown as typeof fetch;
    const ocrText = 'This is private OCR text 12345';
    const res = await handleExtract(postJson({ ocr_text: ocrText }), makeEnv());
    const text = await res.text();
    expect(text).not.toContain(ocrText);
  });

  it('rate-limit binding is keyed by CF-Connecting-IP', async () => {
    const limiter = rateLimit(true);
    const env = makeEnv({ RATE_LIMIT: limiter as unknown as Env['RATE_LIMIT'] });
    globalThis.fetch = jest.fn(async () => geminiOkResponse([])) as unknown as typeof fetch;
    await handleExtract(postJson({ ocr_text: 'hi' }), env);
    expect(limiter.limit).toHaveBeenCalledWith({ key: '1.2.3.4' });
  });

  describe('AI Gateway integration', () => {
    it('targets the AI Gateway URL (account / gateway / google-ai-studio / generateContent)', async () => {
      const fetchSpy = jest.fn(async () =>
        geminiOkResponse([]),
      ) as unknown as typeof fetch;
      globalThis.fetch = fetchSpy;

      const env = makeEnv({
        CF_ACCOUNT_ID: 'acct-abc123',
        AI_GATEWAY_NAME: 'trip-pocket',
      });
      await handleExtract(postJson({ ocr_text: 'hello' }), env);

      const url = (fetchSpy as unknown as jest.Mock).mock.calls[0][0] as string;
      expect(url).toContain('https://gateway.ai.cloudflare.com/v1/acct-abc123/trip-pocket/google-ai-studio/');
      expect(url).toContain('models/gemini-2.5-flash-lite:generateContent');
    });

    it('sends cf-aig-authorization Bearer header', async () => {
      const fetchSpy = jest.fn(async () =>
        geminiOkResponse([]),
      ) as unknown as typeof fetch;
      globalThis.fetch = fetchSpy;

      const env = makeEnv({ CF_AIG_TOKEN: 'tok-xyz' });
      await handleExtract(postJson({ ocr_text: 'hello' }), env);

      const init = (fetchSpy as unknown as jest.Mock).mock.calls[0][1] as RequestInit;
      const headers = new Headers(init.headers);
      expect(headers.get('cf-aig-authorization')).toBe('Bearer tok-xyz');
    });

    it('still passes the Gemini API key to the upstream provider', async () => {
      const fetchSpy = jest.fn(async () =>
        geminiOkResponse([]),
      ) as unknown as typeof fetch;
      globalThis.fetch = fetchSpy;

      const env = makeEnv({ GEMINI_API_KEY: 'gemini-secret' });
      await handleExtract(postJson({ ocr_text: 'hello' }), env);

      const url = (fetchSpy as unknown as jest.Mock).mock.calls[0][0] as string;
      expect(url).toContain('?key=gemini-secret');
    });

    it('returns 500 when CF_AIG_TOKEN is missing', async () => {
      const env = makeEnv({ CF_AIG_TOKEN: '' });
      const res = await handleExtract(postJson({ ocr_text: 'hello' }), env);
      expect(res.status).toBe(500);
    });

    it('returns 500 when CF_ACCOUNT_ID is missing', async () => {
      const env = makeEnv({ CF_ACCOUNT_ID: '' });
      const res = await handleExtract(postJson({ ocr_text: 'hello' }), env);
      expect(res.status).toBe(500);
    });

    it('returns 500 when AI_GATEWAY_NAME is missing', async () => {
      const env = makeEnv({ AI_GATEWAY_NAME: '' });
      const res = await handleExtract(postJson({ ocr_text: 'hello' }), env);
      expect(res.status).toBe(500);
    });
  });
});
