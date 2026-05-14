import { requireEntitlement } from '../src/entitlement';

type RCBody = {
  subscriber: {
    entitlements: { pro?: { expires_date: string | null } };
  };
};

const VALID_ID = '$RCAnonymousID:0123456789abcdef0123456789abcdef';

function makeRequest(headers: Record<string, string> = {}): Request {
  return new Request('https://proxy.example.com/extract', {
    method: 'POST',
    headers,
  });
}

function rcResponse(body: RCBody, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function activeBody(): RCBody {
  return {
    subscriber: {
      entitlements: { pro: { expires_date: new Date(Date.now() + 60_000).toISOString() } },
    },
  };
}

function expiredBody(): RCBody {
  return {
    subscriber: {
      entitlements: { pro: { expires_date: new Date(Date.now() - 60_000).toISOString() } },
    },
  };
}

afterEach(() => {
  jest.restoreAllMocks();
});

beforeEach(() => {
  // Reset Workers `caches.default`. Workers runtime gives us a real Cache impl
  // in tests via @cloudflare/workers-types; if we're running on Node Jest the
  // global `caches` won't exist — install a minimal in-memory polyfill.
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
});

describe('requireEntitlement', () => {
  test('401 when header is missing entirely', async () => {
    const env = { RC_REST_API_KEY: 'rc-key' };
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    const result = await requireEntitlement(makeRequest({}), env);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(401);
      expect(await result.response.clone().json()).toEqual({ error: 'missing-user-id' });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('400 when header shape is invalid', async () => {
    const env = { RC_REST_API_KEY: 'rc-key' };
    const result = await requireEntitlement(makeRequest({ 'X-RC-User-Id': 'not-an-rc-id' }), env);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(400);
      expect(await result.response.clone().json()).toEqual({ error: 'invalid-user-id' });
    }
  });

  test('200 when RC reports active pro entitlement', async () => {
    const env = { RC_REST_API_KEY: 'rc-key' };
    jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(rcResponse(activeBody()));
    const result = await requireEntitlement(makeRequest({ 'X-RC-User-Id': VALID_ID }), env);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.userId).toBe(VALID_ID);
  });

  test('401 entitlement-required when RC reports expired pro', async () => {
    const env = { RC_REST_API_KEY: 'rc-key' };
    jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(rcResponse(expiredBody()));
    const result = await requireEntitlement(makeRequest({ 'X-RC-User-Id': VALID_ID }), env);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(401);
      expect(await result.response.clone().json()).toEqual({ error: 'entitlement-required' });
    }
  });

  test('401 entitlement-required when RC returns empty entitlements map', async () => {
    const env = { RC_REST_API_KEY: 'rc-key' };
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(rcResponse({ subscriber: { entitlements: {} } } as any));
    const result = await requireEntitlement(makeRequest({ 'X-RC-User-Id': VALID_ID }), env);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(401);
      expect(await result.response.clone().json()).toEqual({ error: 'entitlement-required' });
    }
  });

  test('401 entitlement-required when RC returns pro with null expires_date', async () => {
    const env = { RC_REST_API_KEY: 'rc-key' };
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        rcResponse({ subscriber: { entitlements: { pro: { expires_date: null } } } }),
      );
    const result = await requireEntitlement(makeRequest({ 'X-RC-User-Id': VALID_ID }), env);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(401);
      expect(await result.response.clone().json()).toEqual({ error: 'entitlement-required' });
    }
  });

  test('503 entitlement-check-failed when RC fetch times out (AbortError)', async () => {
    const env = { RC_REST_API_KEY: 'rc-key' };
    const abortError = Object.assign(new Error('The operation was aborted'), {
      name: 'AbortError',
    });
    jest.spyOn(globalThis, 'fetch').mockRejectedValueOnce(abortError);
    const result = await requireEntitlement(makeRequest({ 'X-RC-User-Id': VALID_ID }), env);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(503);
      expect(await result.response.clone().json()).toEqual({ error: 'entitlement-check-failed' });
    }
  });

  test('cache hit on second call within TTL — single fetch to RC', async () => {
    const env = { RC_REST_API_KEY: 'rc-key' };
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(rcResponse(activeBody()));
    await requireEntitlement(makeRequest({ 'X-RC-User-Id': VALID_ID }), env);
    await requireEntitlement(makeRequest({ 'X-RC-User-Id': VALID_ID }), env);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test('503 entitlement-check-failed when RC returns 5xx', async () => {
    const env = { RC_REST_API_KEY: 'rc-key' };
    jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('boom', { status: 502 }));
    const result = await requireEntitlement(makeRequest({ 'X-RC-User-Id': VALID_ID }), env);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(503);
      expect(await result.response.clone().json()).toEqual({ error: 'entitlement-check-failed' });
    }
  });

  test('500 server-misconfigured when RC_REST_API_KEY is empty', async () => {
    const env = { RC_REST_API_KEY: '' };
    const result = await requireEntitlement(makeRequest({ 'X-RC-User-Id': VALID_ID }), env);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(500);
      expect(await result.response.clone().json()).toEqual({ error: 'server-misconfigured' });
    }
  });
});
