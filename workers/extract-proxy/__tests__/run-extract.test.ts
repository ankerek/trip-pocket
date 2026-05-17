import { runExtract, RunExtractError } from '../src/index';
import type { Env } from '../src/index';

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    GEMINI_API_KEY: 'gem',
    GOOGLE_PLACES_API_KEY: 'pl',
    CF_ACCOUNT_ID: 'acct',
    AI_GATEWAY_NAME: 'gw',
    CF_AIG_TOKEN: 'aig',
    RATE_LIMIT: { limit: async () => ({ success: true }) } as Env['RATE_LIMIT'],
    RC_REST_API_KEY: 'rc',
    EXTRACT_STATE: {} as KVNamespace,
    ...overrides,
  };
}

function geminiOk(
  places: Array<{
    name: string;
    city: string;
    category: string;
    address?: string;
    country_code?: string;
  }>,
): Response {
  const padded = places.map((p) => ({ address: '', country_code: '', ...p }));
  return new Response(
    JSON.stringify({
      candidates: [
        { content: { parts: [{ text: JSON.stringify({ places: padded }) }] } },
      ],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

describe('runExtract — text mode', () => {
  let original: typeof fetch;
  beforeEach(() => {
    original = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = original;
  });

  it('returns places + model on success', async () => {
    globalThis.fetch = (async () =>
      geminiOk([{ name: 'A', city: 'B', category: 'food' }])) as typeof fetch;
    const result = await runExtract({ mode: 'text', text: 'hi' }, makeEnv());
    expect(result.places).toHaveLength(1);
    expect(result.model).toBe('gemini-2.5-flash-lite');
  });

  it('returns empty places when Gemini classifies as noise', async () => {
    globalThis.fetch = (async () => geminiOk([])) as typeof fetch;
    const result = await runExtract({ mode: 'text', text: 'meme' }, makeEnv());
    expect(result.places).toEqual([]);
  });

  it('coerces lowercase country_code', async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      places: [
                        {
                          name: 'A',
                          city: 'B',
                          address: '',
                          category: 'food',
                          country_code: 'jp',
                        },
                      ],
                    }),
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as typeof fetch;
    const result = await runExtract({ mode: 'text', text: 'hi' }, makeEnv());
    expect(result.places[0]?.country_code).toBe('JP');
  });

  it('coerces missing country_code to empty string (place is preserved)', async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      places: [{ name: 'X', city: 'Y', address: '', category: 'food' }],
                    }),
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as typeof fetch;
    const result = await runExtract({ mode: 'text', text: 'hi' }, makeEnv());
    expect(result.places[0]?.country_code).toBe('');
  });

  it('keeps good places when one place has a bad country_code', async () => {
    globalThis.fetch = (async () =>
      geminiOk([
        { name: 'Good', city: 'Tokyo', category: 'food', country_code: 'JP' },
        { name: 'Bad', city: 'Tokyo', category: 'food', country_code: 'JPN' },
      ])) as typeof fetch;
    const result = await runExtract({ mode: 'text', text: 'hi' }, makeEnv());
    expect(result.places).toHaveLength(2);
    expect(result.places[0]?.country_code).toBe('JP');
    expect(result.places[1]?.country_code).toBe('');
  });
});

describe('runExtract — error classification', () => {
  let original: typeof fetch;
  beforeEach(() => {
    original = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = original;
  });

  it('throws server-misconfigured when GEMINI_API_KEY missing', async () => {
    await expect(
      runExtract({ mode: 'text', text: 'hi' }, makeEnv({ GEMINI_API_KEY: '' })),
    ).rejects.toMatchObject({
      name: 'RunExtractError',
      code: 'server-misconfigured',
      status: 500,
    });
  });

  it('throws server-misconfigured when CF_AIG_TOKEN missing', async () => {
    await expect(
      runExtract({ mode: 'text', text: 'hi' }, makeEnv({ CF_AIG_TOKEN: '' })),
    ).rejects.toMatchObject({ code: 'server-misconfigured', status: 500 });
  });

  it('throws server-misconfigured when CF_ACCOUNT_ID missing', async () => {
    await expect(
      runExtract({ mode: 'text', text: 'hi' }, makeEnv({ CF_ACCOUNT_ID: '' })),
    ).rejects.toMatchObject({ code: 'server-misconfigured', status: 500 });
  });

  it('throws server-misconfigured when AI_GATEWAY_NAME missing', async () => {
    await expect(
      runExtract({ mode: 'text', text: 'hi' }, makeEnv({ AI_GATEWAY_NAME: '' })),
    ).rejects.toMatchObject({ code: 'server-misconfigured', status: 500 });
  });

  it('throws upstream-error on Gemini 5xx', async () => {
    globalThis.fetch = (async () =>
      new Response('boom', { status: 500 })) as typeof fetch;
    await expect(runExtract({ mode: 'text', text: 'hi' }, makeEnv())).rejects.toMatchObject({
      code: 'upstream-error',
      status: 502,
    });
  });

  it('throws upstream-rate-limited on Gemini 429 with carry-through retry-after', async () => {
    globalThis.fetch = (async () =>
      new Response('rate', {
        status: 429,
        headers: { 'retry-after': '42' },
      })) as typeof fetch;
    await expect(runExtract({ mode: 'text', text: 'hi' }, makeEnv())).rejects.toMatchObject({
      code: 'upstream-rate-limited',
      status: 429,
      retryAfter: '42',
    });
  });

  it('throws upstream-malformed-inner-json when Gemini returns broken JSON', async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: '{ "places": [' }] } }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as typeof fetch;
    await expect(runExtract({ mode: 'text', text: 'hi' }, makeEnv())).rejects.toMatchObject({
      code: 'upstream-malformed-inner-json',
    });
  });

  it('throws upstream-schema-violation when Gemini emits a place with unknown category', async () => {
    globalThis.fetch = (async () =>
      geminiOk([{ name: 'X', city: 'Y', category: 'unknown-cat' }])) as typeof fetch;
    await expect(runExtract({ mode: 'text', text: 'hi' }, makeEnv())).rejects.toMatchObject({
      code: 'upstream-schema-violation',
    });
  });
});

describe('runExtract — AI Gateway integration (HTTP-wire concerns)', () => {
  let original: typeof fetch;
  beforeEach(() => {
    original = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = original;
  });

  it('targets the AI Gateway URL with account / gateway / google-ai-studio / generateContent', async () => {
    const fetchSpy = jest.fn(async () => geminiOk([])) as unknown as typeof fetch;
    globalThis.fetch = fetchSpy;
    await runExtract(
      { mode: 'text', text: 'hi' },
      makeEnv({ CF_ACCOUNT_ID: 'acct-abc123', AI_GATEWAY_NAME: 'trip-pocket' }),
    );
    const url = (fetchSpy as unknown as jest.Mock).mock.calls[0][0] as string;
    expect(url).toContain(
      'https://gateway.ai.cloudflare.com/v1/acct-abc123/trip-pocket/google-ai-studio/',
    );
    expect(url).toContain('models/gemini-2.5-flash-lite:generateContent');
  });

  it('sends cf-aig-authorization Bearer header', async () => {
    const fetchSpy = jest.fn(async () => geminiOk([])) as unknown as typeof fetch;
    globalThis.fetch = fetchSpy;
    await runExtract({ mode: 'text', text: 'hi' }, makeEnv({ CF_AIG_TOKEN: 'tok-xyz' }));
    const init = (fetchSpy as unknown as jest.Mock).mock.calls[0][1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.get('cf-aig-authorization')).toBe('Bearer tok-xyz');
  });

  it('passes the Gemini API key as ?key=', async () => {
    const fetchSpy = jest.fn(async () => geminiOk([])) as unknown as typeof fetch;
    globalThis.fetch = fetchSpy;
    await runExtract({ mode: 'text', text: 'hi' }, makeEnv({ GEMINI_API_KEY: 'gemini-secret' }));
    const url = (fetchSpy as unknown as jest.Mock).mock.calls[0][0] as string;
    expect(url).toContain('?key=gemini-secret');
  });
});

describe('runExtract — vision mode', () => {
  let original: typeof fetch;
  beforeEach(() => {
    original = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = original;
  });

  // JPEG magic-number bytes: 0xff 0xd8 0xff
  const jpegB64 = btoa('\xff\xd8\xff\xe0\x00\x10JFIF\x00');

  it('sends inline_data with image/jpeg mime when bytes are JPEG', async () => {
    const fetchSpy = jest.fn(async () => geminiOk([])) as unknown as typeof fetch;
    globalThis.fetch = fetchSpy;
    await runExtract({ mode: 'vision', imageBase64: jpegB64 }, makeEnv());
    const init = (fetchSpy as unknown as jest.Mock).mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string) as {
      contents: [{ parts: Array<Record<string, unknown>> }];
    };
    const parts = body.contents[0].parts;
    expect(parts[0]).toEqual({
      inline_data: { mime_type: 'image/jpeg', data: jpegB64 },
    });
  });

  it('falls back to image/jpeg when bytes are not recognised', async () => {
    const fetchSpy = jest.fn(async () => geminiOk([])) as unknown as typeof fetch;
    globalThis.fetch = fetchSpy;
    await runExtract({ mode: 'vision', imageBase64: btoa('totally-random') }, makeEnv());
    const init = (fetchSpy as unknown as jest.Mock).mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string) as {
      contents: [{ parts: Array<Record<string, unknown>> }];
    };
    const inline = body.contents[0].parts[0] as { inline_data: { mime_type: string } };
    expect(inline.inline_data.mime_type).toBe('image/jpeg');
  });

  it('appends a caption text part when caption is provided', async () => {
    const fetchSpy = jest.fn(async () => geminiOk([])) as unknown as typeof fetch;
    globalThis.fetch = fetchSpy;
    await runExtract(
      { mode: 'vision', imageBase64: jpegB64, caption: 'check out Tartine' },
      makeEnv(),
    );
    const init = (fetchSpy as unknown as jest.Mock).mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string) as {
      contents: [{ parts: Array<Record<string, unknown>> }];
    };
    expect(body.contents[0].parts).toHaveLength(2);
    expect((body.contents[0].parts[1] as { text: string }).text).toContain(
      'check out Tartine',
    );
  });

  it('does not append a caption part when caption is empty or whitespace', async () => {
    const fetchSpy = jest.fn(async () => geminiOk([])) as unknown as typeof fetch;
    globalThis.fetch = fetchSpy;
    await runExtract(
      { mode: 'vision', imageBase64: jpegB64, caption: '   ' },
      makeEnv(),
    );
    const init = (fetchSpy as unknown as jest.Mock).mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string) as {
      contents: [{ parts: Array<Record<string, unknown>> }];
    };
    expect(body.contents[0].parts).toHaveLength(1);
  });
});

describe('runExtract — privacy', () => {
  let original: typeof fetch;
  beforeEach(() => {
    original = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = original;
  });

  it('never echoes input text in the response object', async () => {
    globalThis.fetch = (async () => geminiOk([])) as typeof fetch;
    const secret = 'This is private OCR text 12345';
    const result = await runExtract({ mode: 'text', text: secret }, makeEnv());
    expect(JSON.stringify(result)).not.toContain(secret);
  });
});

describe('RunExtractError', () => {
  it('carries optional retryAfter for the HTTP layer to pass through', () => {
    const err = new RunExtractError('upstream-rate-limited', 429, '42');
    expect(err.code).toBe('upstream-rate-limited');
    expect(err.status).toBe(429);
    expect(err.retryAfter).toBe('42');
  });
});
