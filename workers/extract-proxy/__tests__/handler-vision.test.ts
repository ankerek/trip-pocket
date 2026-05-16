import { handleExtract } from '../src/index';
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

function rateLimit(allowed = true) {
  return { limit: jest.fn(async () => ({ success: allowed })) };
}

function geminiOkResponse(
  places: Array<{
    name: string;
    city: string;
    category: string;
    address?: string;
    country_code?: string;
  }>,
) {
  const padded = places.map((p) => ({ address: '', country_code: '', ...p }));
  return new Response(
    JSON.stringify({
      candidates: [
        {
          content: {
            parts: [{ text: JSON.stringify({ places: padded }) }],
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
    GOOGLE_PLACES_API_KEY: 'test-places-key',
    CF_ACCOUNT_ID: 'test-account',
    AI_GATEWAY_NAME: 'default',
    CF_AIG_TOKEN: 'test-aig-token',
    RATE_LIMIT: rateLimit(true) as unknown as Env['RATE_LIMIT'],
    RC_REST_API_KEY: 'rc-key',
    ...overrides,
  };
}

function postJson(body: unknown): Request {
  return new Request('https://proxy.example.com/extract', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'CF-Connecting-IP': '1.2.3.4',
      'X-RC-User-Id': VALID_ID,
    },
    body: JSON.stringify(body),
  });
}

function withRcFetch(inner: typeof fetch): typeof fetch {
  return jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.startsWith('https://api.revenuecat.com/v1/subscribers/')) {
      return RC_ACTIVE.clone();
    }
    return inner(input, init);
  }) as unknown as typeof fetch;
}

// 1x1 transparent PNG, base64. Real image bytes — the worker doesn't need to
// decode them, just forward to Gemini, but using something realistic keeps
// the tests honest.
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

describe('handleExtract — request shape', () => {
  let originalFetch: typeof globalThis.fetch;
  let capturedGeminiBody: any = null;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    capturedGeminiBody = null;
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
    globalThis.fetch = withRcFetch(
      jest.fn(async (_url, init) => {
        // Capture the body so tests can assert what the worker sent to Gemini.
        if (init?.body) {
          try {
            capturedGeminiBody = JSON.parse(String(init.body));
          } catch {
            capturedGeminiBody = null;
          }
        }
        return geminiOkResponse([{ name: 'X', city: 'Y', category: 'food' }]);
      }) as unknown as typeof fetch,
    );
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('legacy { ocr_text } request shape (back-compat)', () => {
    it('still works and sends a text-only Gemini request', async () => {
      const res = await handleExtract(postJson({ ocr_text: 'hello tokyo' }), makeEnv());
      expect(res.status).toBe(200);
      expect(capturedGeminiBody?.contents?.[0]?.parts).toEqual([{ text: 'hello tokyo' }]);
    });
  });

  describe('{ mode: "text", text } request shape', () => {
    it('returns 200 and sends a text-only Gemini request', async () => {
      const res = await handleExtract(
        postJson({ mode: 'text', text: 'hello tokyo' }),
        makeEnv(),
      );
      expect(res.status).toBe(200);
      expect(capturedGeminiBody?.contents?.[0]?.parts).toEqual([{ text: 'hello tokyo' }]);
    });

    it('returns 400 when text is empty', async () => {
      const res = await handleExtract(postJson({ mode: 'text', text: '' }), makeEnv());
      expect(res.status).toBe(400);
    });

    it('returns 400 when text is whitespace only', async () => {
      const res = await handleExtract(postJson({ mode: 'text', text: '   ' }), makeEnv());
      expect(res.status).toBe(400);
    });
  });

  describe('{ mode: "vision", imageBase64 } request shape', () => {
    it('returns 200 and sends inline_data part to Gemini', async () => {
      const res = await handleExtract(
        postJson({ mode: 'vision', imageBase64: TINY_PNG_BASE64 }),
        makeEnv(),
      );
      expect(res.status).toBe(200);
      const parts = capturedGeminiBody?.contents?.[0]?.parts;
      expect(parts).toHaveLength(1);
      expect(parts[0]).toMatchObject({
        inline_data: { data: TINY_PNG_BASE64 },
      });
      expect(parts[0].inline_data.mime_type).toMatch(/^image\//);
    });

    it('includes a caption text part when caption is provided', async () => {
      const res = await handleExtract(
        postJson({
          mode: 'vision',
          imageBase64: TINY_PNG_BASE64,
          caption: 'Lunch at Maru Tonkatsu',
        }),
        makeEnv(),
      );
      expect(res.status).toBe(200);
      const parts = capturedGeminiBody?.contents?.[0]?.parts;
      expect(parts).toHaveLength(2);
      expect(parts[0]).toHaveProperty('inline_data');
      expect(parts[1].text).toContain('Lunch at Maru Tonkatsu');
    });

    it('omits caption part when caption is empty string', async () => {
      const res = await handleExtract(
        postJson({ mode: 'vision', imageBase64: TINY_PNG_BASE64, caption: '' }),
        makeEnv(),
      );
      expect(res.status).toBe(200);
      const parts = capturedGeminiBody?.contents?.[0]?.parts;
      expect(parts).toHaveLength(1);
    });

    it('returns 400 when imageBase64 is missing', async () => {
      const res = await handleExtract(postJson({ mode: 'vision' }), makeEnv());
      expect(res.status).toBe(400);
    });

    it('returns 400 when imageBase64 is empty', async () => {
      const res = await handleExtract(
        postJson({ mode: 'vision', imageBase64: '' }),
        makeEnv(),
      );
      expect(res.status).toBe(400);
    });
  });

  describe('invalid request bodies', () => {
    it('returns 400 for unknown mode', async () => {
      const res = await handleExtract(
        postJson({ mode: 'unknown', text: 'hi' }),
        makeEnv(),
      );
      expect(res.status).toBe(400);
    });

    it('returns 400 for empty object', async () => {
      const res = await handleExtract(postJson({}), makeEnv());
      expect(res.status).toBe(400);
    });
  });
});
