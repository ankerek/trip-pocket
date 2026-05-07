import { ExtractionError } from '../extraction';
import { extractFromProxy } from '../proxy';

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
        places: [{ name: 'Maru Tonkatsu', city: 'Tokyo', category: 'food' }],
        model: 'gemini-2.5-flash-lite',
      }),
    ) as unknown as typeof fetch;

    const result = await extractFromProxy('hello', URL);
    expect(result.places).toHaveLength(1);
    expect(result.places[0]?.name).toBe('Maru Tonkatsu');
    expect(result.model).toBe('gemini-2.5-flash-lite');
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
});
