export interface EntitlementEnv {
  RC_REST_API_KEY: string;
}

type RCSubscriberResponse = {
  subscriber?: {
    entitlements?: {
      pro?: {
        expires_date: string | null;
      };
    };
  };
};

const CACHE_TTL_SECONDS = 60;
const RC_FETCH_TIMEOUT_MS = 5_000;
const USER_ID_RE = /^\$RCAnonymousID:[a-f0-9]{32}$/;
const RC_URL = (userId: string): string =>
  `https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(userId)}`;

function jsonError(error: string, status: number): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export type EntitlementResult =
  | { ok: true; userId: string }
  | { ok: false; response: Response };

export async function requireEntitlement(
  request: Request,
  env: EntitlementEnv,
): Promise<EntitlementResult> {
  const userId = request.headers.get('X-RC-User-Id');
  if (!userId) {
    return { ok: false, response: jsonError('missing-user-id', 401) };
  }
  if (!USER_ID_RE.test(userId)) {
    return { ok: false, response: jsonError('invalid-user-id', 400) };
  }
  if (!env.RC_REST_API_KEY) {
    console.error('extract-proxy: RC_REST_API_KEY missing');
    return { ok: false, response: jsonError('server-misconfigured', 500) };
  }

  const cacheKey = new Request(`https://cache.local/rc/${encodeURIComponent(userId)}`);
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) {
    const entitled = (await cached.text()) === '1';
    if (entitled) return { ok: true, userId };
    return { ok: false, response: jsonError('entitlement-required', 401) };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RC_FETCH_TIMEOUT_MS);
  let rc: Response;
  try {
    rc = await fetch(RC_URL(userId), {
      headers: { authorization: `Bearer ${env.RC_REST_API_KEY}` },
      signal: controller.signal,
    });
  } catch (err) {
    console.error('extract-proxy: RC lookup network error', err);
    return { ok: false, response: jsonError('entitlement-check-failed', 503) };
  } finally {
    clearTimeout(timeout);
  }
  if (!rc.ok) {
    console.error(`extract-proxy: RC lookup ${rc.status}`);
    return { ok: false, response: jsonError('entitlement-check-failed', 503) };
  }

  const body = (await rc.json()) as RCSubscriberResponse;
  const entitled = isProActive(body);
  await cache.put(
    cacheKey,
    new Response(entitled ? '1' : '0', {
      headers: { 'cache-control': `max-age=${CACHE_TTL_SECONDS}` },
    }),
  );
  if (!entitled) {
    return { ok: false, response: jsonError('entitlement-required', 401) };
  }
  return { ok: true, userId };
}

function isProActive(body: RCSubscriberResponse): boolean {
  const exp = body.subscriber?.entitlements?.pro?.expires_date;
  if (!exp) return false;
  return new Date(exp).getTime() > Date.now();
}
