// Test seam for the worker integration suite. Replaces `globalThis.fetch`
// with a router that matches outbound calls by URL prefix or regex and
// returns canned responses. Unmatched calls throw — silent fall-through
// would let a real test silently miss a regression (e.g. orchestrator
// stops calling /enrich and the test still passes because the stub
// served nothing).
//
// Scope: only what the worker reaches over the network — RC, IG/TikTok
// HTML, Apify, CDN bytes, Gemini (gateway + Files API), Google Places.
// Everything else inside the worker runs un-mocked: fetcher chain,
// runFetchPost, runExtract fallback, orchestrator state machine, KV
// transitions, dedupe, enrich pipeline, blurb fan-out.

export type RouteHandler = (req: Request) => Response | Promise<Response>;

export type Matcher =
  | string // URL prefix match (must match request URL start)
  | RegExp // URL regex match
  | ((url: string, req: Request) => boolean);

export type RecordedCall = {
  url: string;
  method: string;
  /** Lazily-resolved body — cached on first read so tests can read multiple times. */
  body: () => Promise<string>;
};

export type NetworkMock = {
  /** Register a route. Routes are evaluated in registration order; first match wins. */
  on(match: Matcher, handler: RouteHandler): NetworkMock;
  /** Install the mock as globalThis.fetch. Returns a restore function. */
  install(): () => void;
  /** All recorded calls so far. */
  calls: RecordedCall[];
  /** Filter calls by URL prefix. Convenience for assertions. */
  callsTo(prefix: string): RecordedCall[];
};

export function createNetworkMock(): NetworkMock {
  const routes: Array<{ match: Matcher; handler: RouteHandler }> = [];
  const calls: RecordedCall[] = [];

  const matches = (m: Matcher, url: string, req: Request): boolean => {
    if (typeof m === 'string') return url.startsWith(m);
    if (m instanceof RegExp) return m.test(url);
    return m(url, req);
  };

  const mock: NetworkMock = {
    on(match, handler) {
      routes.push({ match, handler });
      return mock;
    },
    install() {
      const original = globalThis.fetch;
      const fakeFetch = (async (
        input: RequestInfo | URL,
        init?: RequestInit,
      ): Promise<Response> => {
        const req = input instanceof Request ? input : new Request(input, init);
        const url = req.url;
        // Snapshot the body once so the handler AND the test can both read it.
        let bodyCache: string | null = null;
        const bodyReader = async (): Promise<string> => {
          if (bodyCache !== null) return bodyCache;
          try {
            bodyCache = await req.clone().text();
          } catch {
            bodyCache = '';
          }
          return bodyCache;
        };
        calls.push({ url, method: req.method, body: bodyReader });
        for (const r of routes) {
          if (matches(r.match, url, req)) {
            return r.handler(req);
          }
        }
        throw new Error(`network-mock: unmatched fetch ${req.method} ${url}`);
      }) as typeof fetch;
      globalThis.fetch = fakeFetch;
      return () => {
        globalThis.fetch = original;
      };
    },
    calls,
    callsTo(prefix) {
      return calls.filter((c) => c.url.startsWith(prefix));
    },
  };
  return mock;
}

// --- Helpers for common upstream stubs ---------------------------------

export const VALID_RC_USER_ID = '$RCAnonymousID:0123456789abcdef0123456789abcdef';

/** Active RC entitlement (expires in 60s). Use as a handler for RC routes. */
export function rcActiveHandler(): RouteHandler {
  return () =>
    new Response(
      JSON.stringify({
        subscriber: {
          entitlements: { pro: { expires_date: new Date(Date.now() + 60_000).toISOString() } },
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
}

/** Installs a Workers cache polyfill at `globalThis.caches`. Returns a restore fn. */
export function installCachesPolyfill(): () => void {
  const store = new Map<string, Response>();
  const original = (globalThis as unknown as { caches?: unknown }).caches;
  (globalThis as unknown as { caches: unknown }).caches = {
    default: {
      async match(key: Request): Promise<Response | undefined> {
        const r = store.get(key.url);
        return r ? r.clone() : undefined;
      },
      async put(key: Request, value: Response): Promise<void> {
        store.set(key.url, value.clone());
      },
    },
  };
  return () => {
    (globalThis as unknown as { caches: unknown }).caches = original;
  };
}

/** In-memory KV stub matching the subset of the API the worker uses. */
export function makeKv(): {
  store: Map<string, string>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
  get(key: string): Promise<string | null>;
} {
  const store = new Map<string, string>();
  return {
    store,
    async put(key, value) {
      store.set(key, value);
    },
    async get(key) {
      return store.get(key) ?? null;
    },
  };
}

/**
 * Returns a `ctx` whose `waitUntil` records and awaits the promise. The
 * orchestrator runs inside `ctx.waitUntil(...)` via handleExtractPost,
 * so tests need to `await ctx.settle()` after the POST returns to let
 * the pipeline finish before asserting on KV state.
 */
export function makeAwaitableCtx(): {
  waitUntil: (p: Promise<unknown>) => void;
  settle(): Promise<void>;
} {
  const pending: Array<Promise<unknown>> = [];
  return {
    waitUntil(p) {
      pending.push(p);
    },
    async settle() {
      // Drain in waves — orchestrate() does not itself schedule more
      // waitUntils, but video mode does (Files API DELETE cleanup), so
      // be robust to new entries appearing mid-await.
      while (pending.length > 0) {
        const batch = pending.splice(0, pending.length);
        await Promise.allSettled(batch);
      }
    },
  };
}
