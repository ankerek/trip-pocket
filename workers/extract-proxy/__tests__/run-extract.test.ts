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
      candidates: [{ content: { parts: [{ text: JSON.stringify({ places: padded }) }] } }],
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
    globalThis.fetch = (async () => new Response('boom', { status: 500 })) as typeof fetch;
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

describe('runExtract — Gemini retry on transient', () => {
  let original: typeof fetch;
  beforeEach(() => {
    original = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = original;
  });

  it('retries once on Gemini 503 then succeeds', async () => {
    // Real-world: Gemini's "model is currently experiencing high demand"
    // 503 typically clears within a second. One in-call retry catches
    // it without surfacing a failure to the user.
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls === 1) return new Response('high demand', { status: 503 });
      return geminiOk([{ name: 'A', city: 'B', category: 'food' }]);
    }) as typeof fetch;
    const result = await runExtract({ mode: 'text', text: 'hi' }, makeEnv());
    expect(calls).toBe(2);
    expect(result.places).toHaveLength(1);
  });

  it('retries once on Gemini 429 then succeeds', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls === 1) return new Response('rate limited', { status: 429 });
      return geminiOk([{ name: 'A', city: 'B', category: 'food' }]);
    }) as typeof fetch;
    const result = await runExtract({ mode: 'text', text: 'hi' }, makeEnv());
    expect(calls).toBe(2);
    expect(result.places).toHaveLength(1);
  });

  it('retries once on network error then succeeds', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls === 1) throw new TypeError('connection reset');
      return geminiOk([{ name: 'A', city: 'B', category: 'food' }]);
    }) as typeof fetch;
    const result = await runExtract({ mode: 'text', text: 'hi' }, makeEnv());
    expect(calls).toBe(2);
    expect(result.places).toHaveLength(1);
  });

  it('throws upstream-error after exhausting one retry on persistent 503', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response('high demand', { status: 503 });
    }) as typeof fetch;
    await expect(runExtract({ mode: 'text', text: 'hi' }, makeEnv())).rejects.toMatchObject({
      code: 'upstream-error',
      status: 502,
    });
    expect(calls).toBe(2);
  });

  it('does NOT retry on 4xx (permanent)', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response('bad request', { status: 400 });
    }) as typeof fetch;
    await expect(runExtract({ mode: 'text', text: 'hi' }, makeEnv())).rejects.toMatchObject({
      code: 'upstream-error',
    });
    expect(calls).toBe(1);
  });

  it('does NOT retry on malformed-inner-json (deterministic)', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: '{ "places": [' }] } }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;
    await expect(runExtract({ mode: 'text', text: 'hi' }, makeEnv())).rejects.toMatchObject({
      code: 'upstream-malformed-inner-json',
    });
    expect(calls).toBe(1);
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
    await runExtract({ mode: 'vision', imageBase64: [jpegB64] }, makeEnv());
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
    await runExtract({ mode: 'vision', imageBase64: [btoa('totally-random')] }, makeEnv());
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
      { mode: 'vision', imageBase64: [jpegB64], caption: 'check out Tartine' },
      makeEnv(),
    );
    const init = (fetchSpy as unknown as jest.Mock).mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string) as {
      contents: [{ parts: Array<Record<string, unknown>> }];
    };
    expect(body.contents[0].parts).toHaveLength(2);
    expect((body.contents[0].parts[1] as { text: string }).text).toContain('check out Tartine');
  });

  it('does not append a caption part when caption is empty or whitespace', async () => {
    const fetchSpy = jest.fn(async () => geminiOk([])) as unknown as typeof fetch;
    globalThis.fetch = fetchSpy;
    await runExtract({ mode: 'vision', imageBase64: [jpegB64], caption: '   ' }, makeEnv());
    const init = (fetchSpy as unknown as jest.Mock).mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string) as {
      contents: [{ parts: Array<Record<string, unknown>> }];
    };
    expect(body.contents[0].parts).toHaveLength(1);
  });

  it('sends one inline_data part per image for multi-image carousels', async () => {
    const fetchSpy = jest.fn(async () => geminiOk([])) as unknown as typeof fetch;
    globalThis.fetch = fetchSpy;
    // PNG magic-number: 0x89 0x50 0x4e 0x47 0x0d 0x0a 0x1a 0x0a
    const pngB64 = btoa('\x89PNG\r\n\x1a\n\x00\x00\x00\x0d');
    await runExtract(
      { mode: 'vision', imageBase64: [jpegB64, pngB64, jpegB64], caption: 'cap' },
      makeEnv(),
    );
    const init = (fetchSpy as unknown as jest.Mock).mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string) as {
      contents: [{ parts: Array<Record<string, unknown>> }];
    };
    const parts = body.contents[0].parts;
    // 3 images + 1 caption
    expect(parts).toHaveLength(4);
    expect(parts[0]).toEqual({
      inline_data: { mime_type: 'image/jpeg', data: jpegB64 },
    });
    expect(parts[1]).toEqual({
      inline_data: { mime_type: 'image/png', data: pngB64 },
    });
    expect(parts[2]).toEqual({
      inline_data: { mime_type: 'image/jpeg', data: jpegB64 },
    });
    expect((parts[3] as { text: string }).text).toContain('cap');
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

describe('runExtract — video mode Files-API cleanup ordering', () => {
  let original: typeof fetch;
  beforeEach(() => {
    original = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = original;
  });

  // Regression for a 503-then-403 retry failure observed in prod:
  //  - buildVideoPart used to call ctx.waitUntil(deleteFile(...)) BEFORE
  //    returning, which fired the Files-API DELETE in parallel with
  //    runExtract's generateContent call.
  //  - When Gemini returned a transient 503, the in-call retry slept 1s
  //    and re-issued generateContent with the same file_uri; by then the
  //    DELETE had completed and Gemini answered 403 PERMISSION_DENIED.
  // The fix moves DELETE scheduling to runExtract, AFTER the retry loop.
  // This test enforces that ordering: at the time the second
  // generateContent call fires, no DELETE has been issued.
  it('defers Files-API DELETE until after the 503-retry succeeds', async () => {
    // Force the Files-API transport by returning a body at exactly the
    // cutoff. Using a real Uint8Array (not a stream) keeps the test fast.
    const big = new Uint8Array(18 * 1024 * 1024);

    const fileName = 'files/4qad0tru4zgm';
    const fileUri = 'https://generativelanguage.googleapis.com/v1beta/files/4qad0tru4zgm';
    const events: string[] = [];

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = (init?.method ?? 'GET').toUpperCase();

      // CDN
      if (url.startsWith('https://cdn/')) {
        events.push('cdn-fetch');
        return new Response(big, { status: 200 });
      }
      // Files API upload start
      if (url.includes('/upload/v1beta/files') && method === 'POST') {
        events.push('upload-start');
        return new Response('', {
          status: 200,
          headers: { 'x-goog-upload-url': 'https://upload/session/Z' },
        });
      }
      // Files API upload finalize
      if (url.startsWith('https://upload/session/Z') && method === 'POST') {
        events.push('upload-finalize');
        return new Response(
          JSON.stringify({
            file: { name: fileName, uri: fileUri, mimeType: 'video/mp4', state: 'ACTIVE' },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      // Files API DELETE — this must NOT happen between the two gen calls.
      if (url.includes(fileName) && method === 'DELETE') {
        events.push('file-delete');
        return new Response('', { status: 200 });
      }
      // Gemini generateContent through AI Gateway
      if (url.includes('/google-ai-studio/') && method === 'POST') {
        const callIdx = events.filter((e) => e === 'gen-call').length;
        events.push('gen-call');
        if (callIdx === 0) {
          return new Response(
            JSON.stringify({
              error: {
                code: 503,
                message: 'This model is currently experiencing high demand.',
                status: 'UNAVAILABLE',
              },
            }),
            { status: 503, headers: { 'content-type': 'application/json' } },
          );
        }
        return geminiOk([{ name: 'A', city: 'B', category: 'food' }]);
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }) as typeof fetch;

    const scheduled: Promise<unknown>[] = [];
    const ctx = {
      waitUntil(p: Promise<unknown>) {
        scheduled.push(p);
      },
    };

    const result = await runExtract(
      {
        mode: 'video',
        video: { url: 'https://cdn/reel.mp4' },
        caption: '',
      },
      makeEnv(),
      ctx,
    );

    expect(result.places).toHaveLength(1);

    // Synchronously after runExtract resolves, both gen calls must have
    // fired BEFORE the DELETE was issued — even though the DELETE was
    // scheduled via ctx.waitUntil, which kicks off the promise immediately.
    const genCalls = events.filter((e) => e === 'gen-call').length;
    expect(genCalls).toBe(2);

    const firstDelete = events.indexOf('file-delete');
    const lastGen = events.lastIndexOf('gen-call');
    if (firstDelete !== -1) {
      // If the DELETE has already happened, it must be AFTER both gen calls.
      expect(firstDelete).toBeGreaterThan(lastGen);
    }

    // Flush the cleanup promise the way the runtime would.
    await Promise.all(scheduled);
    expect(events).toContain('file-delete');
  });
});
