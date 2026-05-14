import { getEntitlementUserId } from '@/lib/entitlement/userId';
import { ExtractionError } from '../extraction';
import { extractFromProxy } from '../proxy';

jest.mock('@/lib/entitlement/userId', () => ({
  getEntitlementUserId: jest.fn(async () => '$RCAnonymousID:0123456789abcdef0123456789abcdef'),
}));

const URL = 'https://proxy.example.com/extract';

function jsonResp(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('extractFromProxy', () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns parsed places + model on 200 with valid body', async () => {
    globalThis.fetch = jest.fn(async () =>
      jsonResp(200, {
        places: [
          {
            name: 'Maru Tonkatsu',
            city: 'Tokyo',
            address: '',
            category: 'food',
            country_code: 'JP',
          },
        ],
        model: 'gemini-2.5-flash-lite',
      }),
    ) as unknown as typeof fetch;

    const result = await extractFromProxy('hello', URL);
    expect(result.places).toHaveLength(1);
    expect(result.places[0]?.name).toBe('Maru Tonkatsu');
    expect(result.places[0]?.country_code).toBe('JP');
    expect(result.model).toBe('gemini-2.5-flash-lite');
  });

  it('coerces lowercase country_code to uppercase rather than throwing', async () => {
    globalThis.fetch = jest.fn(async () =>
      jsonResp(200, {
        places: [
          {
            name: 'X',
            city: 'Y',
            address: '',
            category: 'food',
            country_code: 'jp',
          },
        ],
        model: 'gemini-2.5-flash-lite',
      }),
    ) as unknown as typeof fetch;

    const result = await extractFromProxy('hi', URL);
    expect(result.places[0]?.country_code).toBe('JP');
  });

  it('coerces a non-conforming country_code to empty, preserving the place', async () => {
    globalThis.fetch = jest.fn(async () =>
      jsonResp(200, {
        places: [
          {
            name: 'X',
            city: 'Y',
            address: '',
            category: 'food',
            country_code: 'JPN',
          },
        ],
        model: 'gemini-2.5-flash-lite',
      }),
    ) as unknown as typeof fetch;

    const result = await extractFromProxy('hi', URL);
    expect(result.places).toHaveLength(1);
    expect(result.places[0]?.country_code).toBe('');
  });

  it('throws retryable on 200 with malformed body (Zod fails)', async () => {
    globalThis.fetch = jest.fn(async () =>
      jsonResp(200, { places: [{ name: 'X' }], model: 'x' }),
    ) as unknown as typeof fetch;

    await expect(extractFromProxy('hi', URL)).rejects.toMatchObject({
      classification: { kind: 'retryable' },
    });
  });

  it('throws retryable on 200 with non-JSON body', async () => {
    globalThis.fetch = jest.fn(
      async () =>
        new Response('not json at all', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ) as unknown as typeof fetch;

    await expect(extractFromProxy('hi', URL)).rejects.toMatchObject({
      classification: { kind: 'retryable' },
    });
  });

  it('throws entitlement-required on 401', async () => {
    globalThis.fetch = jest.fn(async () =>
      jsonResp(401, { error: 'entitlement-required' }),
    ) as unknown as typeof fetch;

    await expect(extractFromProxy('hi', URL)).rejects.toMatchObject({
      classification: { kind: 'entitlement-required' },
    });
  });

  it('throws permanent on 4xx (non-429)', async () => {
    globalThis.fetch = jest.fn(async () =>
      jsonResp(400, { error: 'invalid-request-body' }),
    ) as unknown as typeof fetch;

    await expect(extractFromProxy('hi', URL)).rejects.toMatchObject({
      classification: { kind: 'permanent' },
    });
  });

  it('throws deferred(retryAfterMs=30000) on 429 with Retry-After: 30', async () => {
    globalThis.fetch = jest.fn(async () =>
      jsonResp(429, { error: 'rate-limited' }, { 'retry-after': '30' }),
    ) as unknown as typeof fetch;

    await expect(extractFromProxy('hi', URL)).rejects.toMatchObject({
      classification: { kind: 'deferred', retryAfterMs: 30000 },
    });
  });

  it('throws deferred(retryAfterMs=60000) on 429 with no Retry-After header', async () => {
    globalThis.fetch = jest.fn(async () =>
      jsonResp(429, { error: 'rate-limited' }),
    ) as unknown as typeof fetch;

    await expect(extractFromProxy('hi', URL)).rejects.toMatchObject({
      classification: { kind: 'deferred', retryAfterMs: 60000 },
    });
  });

  it('throws retryable on 429 with Retry-After exceeding the 5-minute ceiling', async () => {
    globalThis.fetch = jest.fn(async () =>
      jsonResp(429, { error: 'rate-limited' }, { 'retry-after': '600' }),
    ) as unknown as typeof fetch;

    await expect(extractFromProxy('hi', URL)).rejects.toMatchObject({
      classification: { kind: 'retryable' },
    });
  });

  it('throws retryable on 5xx', async () => {
    globalThis.fetch = jest.fn(async () =>
      jsonResp(502, { error: 'upstream' }),
    ) as unknown as typeof fetch;

    await expect(extractFromProxy('hi', URL)).rejects.toMatchObject({
      classification: { kind: 'retryable' },
    });
  });

  it('throws retryable on a network error (fetch rejects)', async () => {
    globalThis.fetch = jest.fn(async () => {
      throw new Error('network fail');
    }) as unknown as typeof fetch;

    await expect(extractFromProxy('hi', URL)).rejects.toMatchObject({
      classification: { kind: 'retryable' },
    });
  });

  it('throws retryable on timeout (AbortError)', async () => {
    globalThis.fetch = jest.fn(async () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    }) as unknown as typeof fetch;

    await expect(extractFromProxy('hi', URL, { timeoutMs: 10 })).rejects.toMatchObject({
      classification: { kind: 'retryable' },
    });
  });

  it('all rejections are ExtractionError instances', async () => {
    globalThis.fetch = jest.fn(async () =>
      jsonResp(500, { error: 'boom' }),
    ) as unknown as typeof fetch;

    let caught: unknown;
    try {
      await extractFromProxy('hi', URL);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ExtractionError);
  });

  it('attaches X-RC-User-Id header on every fetch call', async () => {
    globalThis.fetch = jest.fn(async () =>
      jsonResp(200, {
        places: [],
        model: 'gemini-2.5-flash-lite',
      }),
    ) as unknown as typeof fetch;

    await extractFromProxy('hi', URL);

    expect(globalThis.fetch).toHaveBeenCalledWith(
      URL,
      expect.objectContaining({
        headers: expect.objectContaining({
          'X-RC-User-Id': '$RCAnonymousID:0123456789abcdef0123456789abcdef',
        }),
      }),
    );
  });

  it('throws entitlement-required (without fetching) when getEntitlementUserId rejects', async () => {
    (getEntitlementUserId as jest.Mock).mockRejectedValueOnce(new Error('rc-not-ready'));
    globalThis.fetch = jest.fn() as unknown as typeof fetch;

    await expect(extractFromProxy('hi', URL)).rejects.toMatchObject({
      classification: { kind: 'entitlement-required' },
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
