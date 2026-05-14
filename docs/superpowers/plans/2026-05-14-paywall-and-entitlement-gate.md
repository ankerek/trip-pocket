# Paywall, IAP, and entitlement gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the placeholder onboarding paywall with a real RevenueCat-backed purchase flow, lock the app behind the `pro` entitlement on every launch and foreground, and authenticate the Cloudflare extraction proxy on RC entitlement so only trial-active or subscribed users hit the LLM and Apify paths.

**Architecture:** Three layers. (1) **Worker auth** — a `requireEntitlement` middleware that validates the `X-RC-User-Id` header shape, looks up the subscriber via RC REST, edge-caches the result for 60s, and gates `/extract`, `/enrich`, `/fetch-post` (not `/photo/:name`). (2) **App entitlement module** — `lib/entitlement/` owns RC SDK init, status caching, the plan tile config, and an `EntitlementProvider` that exposes status / purchase / restore via a hook. Mounts above the existing `ready` guard so cached status is available before the splash hides. (3) **Pipeline pause/resume** — additive nullable columns (`sources.extraction_paused_reason`, `sources.url_fetch_paused_reason`, `places.enrichment_paused_reason`) let a 401 from the proxy mark queued work as paused (rather than failed); a resume hook fires when entitlement flips inactive→active and re-enqueues the paused rows.

**Tech Stack:** `react-native-purchases` (RevenueCat SDK), expo-router, Expo SQLite, Cloudflare Workers + Workers caches API, Jest + React Native Testing Library. Spec: `docs/superpowers/specs/2026-05-14-paywall-and-entitlement-gate-design.md`.

**Divergence from spec:** the spec describes the paused-state as a new value `'paused-entitlement'` in the existing `extraction_status` / `enrichment_status` CHECK enums. The implementation instead adds two additive nullable columns to `sources` (`extraction_paused_reason TEXT`, `url_fetch_paused_reason TEXT`) and one to `places` (`enrichment_paused_reason TEXT`). Reasons:

1. The existing enums are guarded by SQLite CHECK constraints which can't be modified without a table rebuild; an additive column is a one-line `ALTER TABLE` and lets the migration ship without dev-DB wipes.
2. The URL-fetch path runs on `sources` rows in `modules/processing/processing.ts` (the `pending_imports` row is `DELETE`d in `modules/capture/ingest.ts:81-82` once the source row is created), so the spec's `pending_imports` reference is structurally wrong — the pause has to live on `sources`.

Behavior is identical to the spec's intent: sweep filters skip rows with a non-null `*_paused_reason`, and the resume sweep clears the column and re-enqueues.

**Pre-flight before starting:**

1. Confirm baseline test suite is green: `npm test --silent`. The worker suite runs separately: `npm test --silent --prefix workers/extract-proxy`.
2. Confirm typecheck is green: `npx tsc --noEmit`.
3. Have the spec open (`docs/superpowers/specs/2026-05-14-paywall-and-entitlement-gate-design.md`) — every task references its section.
4. Have a dev iPhone (or simulator with Sign in with Apple ID) on hand. Sandbox-purchase tests cannot run without a physical or signed-in simulator.

---

## Task 0: Manual bootstrap (dashboards, no code)

**Goal:** Stand up the App Store Connect products, RevenueCat project, and secrets that subsequent tasks depend on. Has no code deliverable — these are dashboard actions. **Done when** every "Done when" line below is checked.

Spec ref: §"Manual bootstrap" (lines 426–445).

- [ ] **Step 0.1: App Store Connect — create the three subscriptions**
  1.  Sign in to App Store Connect for the Trip Pocket app record (Apple Team `WL5ALL46C4`, ASC App ID `6768290313`).
  2.  Apps → Trip Pocket → Subscriptions → "+" → create one **subscription group** named `Trip Pocket Pro`.
  3.  In that group, create three auto-renewing subscription products:
      - Product ID `trip_pocket_pro_weekly`, duration 1 week
      - Product ID `trip_pocket_pro_monthly`, duration 1 month
      - Product ID `trip_pocket_pro_yearly`, duration 1 year
  4.  For each product, add a free **introductory offer** of length **7 days**.
  5.  Set placeholder prices (any value; revisable before submission).

  **Done when:** all three products show in App Store Connect with status "Ready to Submit" and each shows a 7-day intro offer attached.

- [ ] **Step 0.2: App Store Connect — sandbox tester**
  1.  Users and Access → Sandbox Testers → "+".
  2.  Create one account with a fresh email (use a `+test` alias on a real Apple ID inbox you control).
  3.  On the dev iPhone: Settings → Developer → Sandbox Apple Account → sign in with this account.

  **Done when:** Settings → Developer → Sandbox Apple Account shows the tester email.

- [ ] **Step 0.3: RevenueCat — project + entitlement + offering**
  1.  Sign up at https://app.revenuecat.com (or sign in if an org exists).
  2.  Create a new project named `Trip Pocket`. Add one app → iOS → bundle ID `com.trippocket.app`. Add a second app entry for `com.trippocket.app.dev` so dev builds use the same RC project.
  3.  Account → Apple App Store Shared Secret → paste the shared secret from App Store Connect (Apps → Trip Pocket → App Information → App-Specific Shared Secret).
  4.  Entitlements → "+" → create entitlement with identifier `pro`.
  5.  Products → "+" → attach all three App Store products to the entitlement `pro`.
  6.  Offerings → create one offering named `default` containing the three products as **packages** (`$rc_weekly`, `$rc_monthly`, `$rc_annual`). Mark the offering as Current.

  **Done when:** RC dashboard shows entitlement `pro` with three products attached, and offering `default` (Current) with three packages.

- [ ] **Step 0.4: RevenueCat — keys**
  1.  Project settings → API keys → copy the **iOS Public SDK Key**.
  2.  Project settings → API keys → copy the **Secret API key (v1)**.

  No code change yet — just save both values somewhere safe. They get installed in Task 1 (worker secret) and Task 4 (EAS Secret).

  **Done when:** both keys are copied and saved.

- [ ] **Step 0.5: Smoke check**

  No commit. This is a manual sanity check. Confirm you can hit the RC REST API from your terminal:

  ```bash
  curl -s -H "Authorization: Bearer $RC_REST_KEY" \
    "https://api.revenuecat.com/v1/subscribers/\$RCAnonymousID:0123456789abcdef0123456789abcdef" \
    | head -c 200
  ```

  Expected: a JSON response with a `subscriber` field (the user won't exist, but RC returns a valid empty-state subscriber object). If you get `401 Unauthorized`, the REST key is wrong.

  **Done when:** you've seen a JSON `subscriber` payload back from RC REST.

---

## Task 1: Worker — `requireEntitlement` middleware

**Goal:** A pure middleware function that validates the `X-RC-User-Id` header, calls RC REST, caches for 60s in `caches.default`, and returns either `{ ok: true, userId }` or a ready-to-return error `Response`. No handlers wired yet — that's Task 2.

Spec ref: §`workers/extract-proxy/src/entitlement.ts` (new) lines 345–408.

**Files:**

- Create: `workers/extract-proxy/src/entitlement.ts`
- Create: `workers/extract-proxy/__tests__/entitlement.test.ts`
- Modify: `workers/extract-proxy/src/index.ts:15-26` (add `RC_REST_API_KEY` to `Env`)

- [ ] **Step 1.1: Write the failing test file**

Create `workers/extract-proxy/__tests__/entitlement.test.ts`:

```ts
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
  test('400 when header is missing entirely', async () => {
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
```

- [ ] **Step 1.2: Run tests to verify they fail**

```bash
npm test --silent --prefix workers/extract-proxy -- entitlement.test.ts
```

Expected: 7 failing tests with "Cannot find module '../src/entitlement'".

- [ ] **Step 1.3: Implement `entitlement.ts`**

Create `workers/extract-proxy/src/entitlement.ts`:

```ts
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
const USER_ID_RE = /^\$RCAnonymousID:[a-f0-9]{32}$/;
const RC_URL = (userId: string): string =>
  `https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(userId)}`;

function jsonError(error: string, status: number): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export type EntitlementResult = { ok: true; userId: string } | { ok: false; response: Response };

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

  const rc = await fetch(RC_URL(userId), {
    headers: { authorization: `Bearer ${env.RC_REST_API_KEY}` },
  });
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
```

- [ ] **Step 1.4: Run tests to verify they pass**

```bash
npm test --silent --prefix workers/extract-proxy -- entitlement.test.ts
```

Expected: 7 passing tests.

- [ ] **Step 1.5: Extend the worker `Env` interface**

Open `workers/extract-proxy/src/index.ts`. Find the `Env` interface (around line 15) and add `RC_REST_API_KEY`:

```ts
export interface Env {
  GEMINI_API_KEY: string;
  GOOGLE_PLACES_API_KEY: string;
  CF_ACCOUNT_ID: string;
  AI_GATEWAY_NAME: string;
  CF_AIG_TOKEN: string;
  RATE_LIMIT: RateLimitBinding;
  APIFY_TOKEN?: string;
  APIFY_ACTOR_ID?: string;
  RC_REST_API_KEY: string; // <-- new
}
```

- [ ] **Step 1.6: Run full worker test suite to confirm no regression**

```bash
npm test --silent --prefix workers/extract-proxy
```

Expected: all previously-passing tests still pass; new entitlement tests pass.

- [ ] **Step 1.7: Commit**

```bash
git add workers/extract-proxy/src/entitlement.ts \
        workers/extract-proxy/__tests__/entitlement.test.ts \
        workers/extract-proxy/src/index.ts
git commit -m "feat(worker): requireEntitlement middleware with RC REST + 60s edge cache"
```

---

## Task 2: Worker — gate the three handlers

**Goal:** Wrap `handleExtract`, `handleEnrich`, and `handleFetchPost` in `requireEntitlement`. Update the existing handler tests to pass a valid `X-RC-User-Id` header (otherwise they'd all 401), and add one explicit test per handler that asserts the gate fires.

Spec ref: §`workers/extract-proxy/src/index.ts` changes (lines 410–420).

**Files:**

- Modify: `workers/extract-proxy/src/index.ts` (top of `handleExtract`)
- Modify: `workers/extract-proxy/src/enrich.ts` (top of `handleEnrich`)
- Modify: `workers/extract-proxy/src/fetch-post.ts` (top of `handleFetchPost`)
- Modify: `workers/extract-proxy/__tests__/handler.test.ts` (extract tests)
- Modify: `workers/extract-proxy/__tests__/enrich.test.ts`
- Modify: `workers/extract-proxy/__tests__/fetch-post.test.ts`
- Modify: `workers/extract-proxy/__tests__/fetch-post-tiktok-rehyd.test.ts`

- [ ] **Step 2.1: Add a shared `validHeaders()` test helper**

Each handler test file constructs a `Request`. The simplest change is to add the header to every existing call. To avoid editing every test invocation, add a helper at the top of each test file and patch the existing `postJson` (or equivalent factory) once.

For each of the four test files above, find the existing request factory (e.g. `postJson`, `makeRequest`) and add the header inline. Example for `handler.test.ts`:

```ts
const VALID_ID = '$RCAnonymousID:0123456789abcdef0123456789abcdef';

function postJson(body: unknown, ip = '1.2.3.4'): Request {
  return new Request('https://proxy.example.com/extract', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'CF-Connecting-IP': ip,
      'X-RC-User-Id': VALID_ID, // <-- new
    },
    body: JSON.stringify(body),
  });
}
```

Repeat for `enrich.test.ts`, `fetch-post.test.ts`, `fetch-post-tiktok-rehyd.test.ts`.

**Important:** some tests build the `Request` inline rather than going through `postJson` / `makeRequest` (search each file for `new Request(` after the factory definition — `handler.test.ts:68-90`, `enrich.test.ts:115-128`, etc.). Add `'X-RC-User-Id': VALID_ID` to every such inline POST request as well. The exception is the new "missing header" tests added in Step 2.3, which intentionally omit the header.

- [ ] **Step 2.2: Make sure the existing tests still mock the RC `fetch` call**

The entitlement middleware will issue one `fetch` to `api.revenuecat.com` per fresh test (caches.default is reset in `beforeEach`). The existing handler tests mock `globalThis.fetch` via a `FetchScript` pattern. Extend each test file's `mockFetch` (or `fetchScript`) builder so the **first** matched request is always the RC subscribers endpoint returning an active subscription.

In each handler test file, find the test setup that installs the fetch mock. Above the existing matchers, add:

```ts
const RC_ACTIVE = new Response(
  JSON.stringify({
    subscriber: {
      entitlements: { pro: { expires_date: new Date(Date.now() + 60_000).toISOString() } },
    },
  }),
  { status: 200, headers: { 'content-type': 'application/json' } },
);

function withRcMatcher(script: FetchScript): FetchScript {
  return [
    {
      match: (url) => url.startsWith('https://api.revenuecat.com/v1/subscribers/'),
      response: () => RC_ACTIVE.clone(),
    },
    ...script,
  ];
}
```

Use `withRcMatcher(...)` to wrap existing script values where the test wires `fetch`. Also add the same `caches.default` polyfill from `entitlement.test.ts` step 1.1 in each file's `beforeEach`.

- [ ] **Step 2.3: Add a new "gate fires" test per handler**

Append to each handler test file one test of the form:

```ts
test('returns 401 entitlement-required when X-RC-User-Id header is missing', async () => {
  const env = makeEnv();
  const req = new Request('https://proxy.example.com/extract', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(validBody),
  });
  const res = await handleExtract(req, env);
  expect(res.status).toBe(401);
  expect(await res.clone().json()).toEqual({ error: 'missing-user-id' });
});
```

Substitute `handleEnrich` / `handleFetchPost` and the right URL path / body for the other two. Add the same `RC_REST_API_KEY: 'rc-key'` to each `makeEnv()` factory's defaults so existing tests have it available.

- [ ] **Step 2.4: Wire `requireEntitlement` into the three handlers**

In `workers/extract-proxy/src/index.ts`, inside `handleExtract` after the method check but before any other work:

```ts
import { requireEntitlement } from './entitlement';

export async function handleExtract(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') {
    return errorResponse('method-not-allowed', 405);
  }

  const gate = await requireEntitlement(request, env);
  if (!gate.ok) return gate.response;

  // ... rest of existing handler body
}
```

Same shape inside `workers/extract-proxy/src/enrich.ts` (top of `handleEnrich`) and `workers/extract-proxy/src/fetch-post.ts` (top of `handleFetchPost`). Each file needs `import { requireEntitlement } from './entitlement';`.

- [ ] **Step 2.5: Run the worker test suite**

```bash
npm test --silent --prefix workers/extract-proxy
```

Expected: all tests pass.

- [ ] **Step 2.6: Commit**

```bash
git add workers/extract-proxy/
git commit -m "feat(worker): gate /extract, /enrich, /fetch-post on pro entitlement"
```

---

## Task 3: Worker — secrets + deploy + live smoke test

**Goal:** Push the `RC_REST_API_KEY` secret to Cloudflare and confirm the gate works against the live RC API. No code changes.

**Files:**

- Modify: `workers/extract-proxy/wrangler.toml` (documentation comment only)

- [ ] **Step 3.1: Push the worker secret**

```bash
cd workers/extract-proxy
wrangler secret put RC_REST_API_KEY
# Paste the secret API key from Task 0.4 step 2 when prompted
```

Expected: `✨ Success! Uploaded secret RC_REST_API_KEY`.

- [ ] **Step 3.2: Verify the secret is registered**

```bash
wrangler secret list
```

Expected: a row with name `RC_REST_API_KEY`.

- [ ] **Step 3.3: Document the secret in wrangler.toml**

Open `workers/extract-proxy/wrangler.toml`. Find the section that documents other secrets (look for `# Secrets:` or `[vars]`). Add a comment line:

```toml
# Secrets (set via `wrangler secret put`):
# - GEMINI_API_KEY
# - CF_AIG_TOKEN
# - GOOGLE_PLACES_API_KEY
# - APIFY_TOKEN
# - RC_REST_API_KEY     # RevenueCat REST API key (server-side, secret)
```

- [ ] **Step 3.4: Deploy**

```bash
wrangler deploy
```

Expected: `Total Upload: ...`, `Deployed extract-proxy ...`.

- [ ] **Step 3.5: Live smoke test — missing header**

Replace `<your-worker-url>` with the deployed worker URL (printed in step 3.4 or visible via `wrangler whoami` / dashboard).

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST \
  -H "content-type: application/json" \
  -d '{}' \
  https://<your-worker-url>/extract
```

Expected: `401`.

- [ ] **Step 3.6: Live smoke test — invalid header**

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST \
  -H "content-type: application/json" \
  -H "X-RC-User-Id: not-rc-shape" \
  -d '{}' \
  https://<your-worker-url>/extract
```

Expected: `400`.

- [ ] **Step 3.7: Live smoke test — unknown but well-formed user ID**

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST \
  -H "content-type: application/json" \
  -H "X-RC-User-Id: \$RCAnonymousID:0123456789abcdef0123456789abcdef" \
  -d '{}' \
  https://<your-worker-url>/extract
```

Expected: `401` (RC returns an empty-state subscriber → `isProActive` returns false).

- [ ] **Step 3.8: Commit**

```bash
git add workers/extract-proxy/wrangler.toml
git commit -m "docs(worker): document RC_REST_API_KEY secret"
```

---

## Task 4: App — install `react-native-purchases` + config

**Goal:** Add the SDK, register the plugin, expose the public RC key via `EXPO_PUBLIC_RC_IOS_API_KEY`.

Spec ref: §"File map" rows for `app.config.ts`, `.env.example`, `eas.json`, `package.json`.

**Files:**

- Modify: `package.json`
- Modify: `app.config.ts`
- Modify: `.env.example` (create if missing)

(`eas.json` is not edited here — the public key lives in EAS Secrets, not in the build profile.)

- [ ] **Step 4.1: Install the SDK**

```bash
npm install react-native-purchases@^9
```

(Pin to a major. Verify the latest 9.x against https://github.com/RevenueCat/react-native-purchases at install time; if RN/Expo 55 compat needs a different major, use that.)

- [ ] **Step 4.2: Register the plugin in app.config.ts**

Open `app.config.ts`. Find the `plugins:` array. Add `'react-native-purchases'` (or its expo plugin entry, check the package's README) after the existing `@sentry/react-native` entry:

```ts
plugins: [
  // ... existing entries ...
  'react-native-purchases',
],
```

- [ ] **Step 4.3: Add the env var to .env.example**

If `.env.example` doesn't exist, create it. Append:

```
# RevenueCat iOS Public SDK Key (Project → API keys in dashboard).
# Stored as an EAS Secret for production builds.
EXPO_PUBLIC_RC_IOS_API_KEY=
```

- [ ] **Step 4.4: Stash the key in your local .env and in EAS Secrets**

```bash
echo 'EXPO_PUBLIC_RC_IOS_API_KEY=<paste-public-key-from-Task-0.4>' >> .env
eas secret:create --scope project --name EXPO_PUBLIC_RC_IOS_API_KEY --value '<paste-public-key>' --type string
```

If `eas secret:create` reports the secret already exists, use `eas secret:list` to confirm and skip.

- [ ] **Step 4.5: Verify the plugin doesn't break a clean build**

```bash
npx expo prebuild --clean --platform ios
```

Expected: completes without error and the resulting Podfile lists `RevenueCat` or `react-native-purchases` as a dependency.

Discard the regenerated `ios/` directory if you want a clean working tree (`git restore ios/` will keep your existing prebuild). The check is just that the plugin parses.

- [ ] **Step 4.6: Commit**

```bash
git add package.json package-lock.json app.config.ts .env.example
git commit -m "feat(app): install react-native-purchases SDK and config"
```

---

## Task 5: App — `lib/entitlement/status.ts` (pure helper)

**Goal:** A pure mapper from RC `CustomerInfo` to our app's `'active' | 'inactive'` enum. No SDK calls — pure function, full unit test coverage.

Spec ref: §`lib/entitlement/status.ts` lines 138–152.

**Files:**

- Create: `lib/entitlement/status.ts`
- Create: `lib/entitlement/__tests__/status.test.ts`

- [ ] **Step 5.1: Write the failing test**

Create `lib/entitlement/__tests__/status.test.ts`:

```ts
import type { CustomerInfo } from 'react-native-purchases';
import { entitlementStatus, ENTITLEMENT_KEY } from '../status';

function customer(activeEntitlements: string[]): CustomerInfo {
  return {
    entitlements: {
      active: Object.fromEntries(activeEntitlements.map((k) => [k, { identifier: k } as never])),
      all: {},
    },
  } as unknown as CustomerInfo;
}

describe('entitlementStatus', () => {
  test('returns inactive when info is null', () => {
    expect(entitlementStatus(null)).toBe('inactive');
  });

  test('returns inactive when active entitlements is empty', () => {
    expect(entitlementStatus(customer([]))).toBe('inactive');
  });

  test('returns inactive when only an unrelated entitlement is active', () => {
    expect(entitlementStatus(customer(['something-else']))).toBe('inactive');
  });

  test('returns active when the pro entitlement is in active', () => {
    expect(entitlementStatus(customer([ENTITLEMENT_KEY]))).toBe('active');
  });

  test('ENTITLEMENT_KEY is the literal "pro"', () => {
    expect(ENTITLEMENT_KEY).toBe('pro');
  });
});
```

- [ ] **Step 5.2: Run the test to verify it fails**

```bash
npm test --silent -- lib/entitlement/__tests__/status.test.ts
```

Expected: failure with "Cannot find module '../status'".

- [ ] **Step 5.3: Implement `status.ts`**

Create `lib/entitlement/status.ts`:

```ts
import type { CustomerInfo } from 'react-native-purchases';

export type EntitlementStatus = 'active' | 'inactive';
export const ENTITLEMENT_KEY = 'pro';

export function entitlementStatus(info: CustomerInfo | null): EntitlementStatus {
  if (!info) return 'inactive';
  return info.entitlements.active[ENTITLEMENT_KEY] ? 'active' : 'inactive';
}
```

- [ ] **Step 5.4: Run the test to verify it passes**

```bash
npm test --silent -- lib/entitlement/__tests__/status.test.ts
```

Expected: 5 passing tests.

- [ ] **Step 5.5: Commit**

```bash
git add lib/entitlement/status.ts lib/entitlement/__tests__/status.test.ts
git commit -m "feat(entitlement): pure status mapper from RC CustomerInfo"
```

---

## Task 6: App — `lib/entitlement/plans.ts` (config)

**Goal:** A pure config module that lists the plan tiles to render and their App Store product IDs. Default selection derives from `PLANS[0]`.

Spec ref: §`lib/entitlement/plans.ts` lines 154–177.

**Files:**

- Create: `lib/entitlement/plans.ts`

- [ ] **Step 6.1: Create `plans.ts`**

```ts
export type PlanId = 'weekly' | 'monthly' | 'yearly';

export interface PlanConfig {
  id: PlanId;
  productId: string;
  label: string;
  badge?: string;
}

// Edit this array (and only this array) when launch plans are finalized.
// The first entry is the default-selected tile.
export const PLANS: PlanConfig[] = [
  { id: 'yearly', productId: 'trip_pocket_pro_yearly', label: 'Yearly', badge: 'BEST VALUE' },
  { id: 'monthly', productId: 'trip_pocket_pro_monthly', label: 'Monthly' },
  { id: 'weekly', productId: 'trip_pocket_pro_weekly', label: 'Weekly' },
];

export const DEFAULT_SELECTED_PLAN: PlanId = PLANS[0].id;
```

- [ ] **Step 6.2: Verify typecheck**

```bash
npx tsc --noEmit
```

Expected: clean.

- [ ] **Step 6.3: Commit**

```bash
git add lib/entitlement/plans.ts
git commit -m "feat(entitlement): plans config array (yearly/monthly/weekly)"
```

---

## Task 7: App — `lib/entitlement/storage.ts` (status cache file)

**Goal:** Persist last-known entitlement status to a file so cold launch can render the right surface before the network call resolves. Mirrors `lib/onboarding/storage.ts`.

Spec ref: §`lib/entitlement/storage.ts` lines 179–186.

**Files:**

- Create: `lib/entitlement/storage.ts`
- Create: `lib/entitlement/__tests__/storage.test.ts`

- [ ] **Step 7.1: Read the existing pattern first**

Quick sanity step. Read `lib/onboarding/storage.ts` start-to-finish — we mirror its shape. Pay attention to:

- How it imports `Paths` from `expo-file-system`.
- How it reads/writes via the `File` class.
- How `isOnboardingComplete()` is synchronous (uses `File.exists()`).
- Any test pattern at `lib/onboarding/__tests__/storage.test.ts`.

- [ ] **Step 7.2: Write the failing test**

Create `lib/entitlement/__tests__/storage.test.ts`. Mirror whatever mocking pattern `lib/onboarding/__tests__/storage.test.ts` uses (typically a Jest mock of `expo-file-system`).

The real `File` class from `expo-file-system` exposes `exists` as a **property**, `textSync()` to read, and `create()` + `write()` to create+write — see `lib/onboarding/storage.ts:9-17`. Mirror that shape in the mock:

```ts
import { File, Paths } from 'expo-file-system';
import { readCachedStatus, writeCachedStatus, resetCachedStatus } from '../storage';

jest.mock('expo-file-system', () => {
  const memory = new Map<string, string>();
  function key(dir: string, name: string): string {
    return `${dir}/${name}`;
  }
  return {
    Paths: { document: '/mock-doc' },
    File: class {
      private path: string;
      constructor(dir: string, name: string) {
        this.path = key(dir, name);
      }
      get exists(): boolean {
        return memory.has(this.path);
      }
      textSync(): string {
        return memory.get(this.path) ?? '';
      }
      create(): void {
        if (!memory.has(this.path)) memory.set(this.path, '');
      }
      write(text: string): void {
        memory.set(this.path, text);
      }
      delete(): void {
        memory.delete(this.path);
      }
    },
    __memory: memory,
  };
});

const fs = jest.requireMock('expo-file-system') as { __memory: Map<string, string> };

beforeEach(() => fs.__memory.clear());

describe('entitlement/storage', () => {
  test('readCachedStatus returns null when file missing', () => {
    expect(readCachedStatus()).toBeNull();
  });

  test('round-trips "active"', () => {
    writeCachedStatus('active');
    expect(readCachedStatus()).toBe('active');
  });

  test('round-trips "inactive"', () => {
    writeCachedStatus('inactive');
    expect(readCachedStatus()).toBe('inactive');
  });

  test('returns null when file content is garbage', () => {
    fs.__memory.set('/mock-doc/entitlement-status.txt', 'banana');
    expect(readCachedStatus()).toBeNull();
  });

  test('resetCachedStatus deletes the file', () => {
    writeCachedStatus('active');
    resetCachedStatus();
    expect(readCachedStatus()).toBeNull();
  });
});
```

- [ ] **Step 7.3: Run the test to verify it fails**

```bash
npm test --silent -- lib/entitlement/__tests__/storage.test.ts
```

Expected: failures.

- [ ] **Step 7.4: Implement `storage.ts`**

Create `lib/entitlement/storage.ts`. Matches the API shape used by `lib/onboarding/storage.ts`: `exists` is a property, `textSync()` reads, `create()` then `write()` writes.

```ts
import { File, Paths } from 'expo-file-system';
import type { EntitlementStatus } from './status';

const FILE_NAME = 'entitlement-status.txt';

function file(): File {
  return new File(Paths.document, FILE_NAME);
}

export function readCachedStatus(): EntitlementStatus | null {
  const f = file();
  if (!f.exists) return null;
  const text = f.textSync().trim();
  if (text === 'active' || text === 'inactive') return text;
  return null;
}

export function writeCachedStatus(status: EntitlementStatus): void {
  const f = file();
  if (!f.exists) f.create();
  f.write(status);
}

export function resetCachedStatus(): void {
  const f = file();
  if (f.exists) f.delete();
}
```

- [ ] **Step 7.5: Run the test to verify it passes**

```bash
npm test --silent -- lib/entitlement/__tests__/storage.test.ts
```

Expected: 5 passing tests.

- [ ] **Step 7.6: Commit**

```bash
git add lib/entitlement/storage.ts lib/entitlement/__tests__/storage.test.ts
git commit -m "feat(entitlement): cache last-known status to file for cold launch"
```

---

## Task 8: App — `lib/entitlement/userId.ts`

**Goal:** A small wrapper around `Purchases.getAppUserID()` that caches the value in-process after the first call.

Spec ref: §`lib/entitlement/userId.ts` lines 188–194.

**Files:**

- Create: `lib/entitlement/userId.ts`

- [ ] **Step 8.1: Implement `userId.ts`**

```ts
import Purchases from 'react-native-purchases';

let cached: string | null = null;

export async function getEntitlementUserId(): Promise<string> {
  if (cached !== null) return cached;
  const id = await Purchases.getAppUserID();
  cached = id;
  return id;
}

// Test-only — drops the cache so the next call goes back to the SDK.
export function _resetEntitlementUserIdCacheForTests(): void {
  cached = null;
}
```

- [ ] **Step 8.2: Verify typecheck**

```bash
npx tsc --noEmit
```

Expected: clean.

- [ ] **Step 8.3: Commit**

```bash
git add lib/entitlement/userId.ts
git commit -m "feat(entitlement): cached app-user-id helper for proxy header"
```

---

## Task 9: App — `lib/entitlement/provider.tsx`

**Goal:** React provider that initializes RC, exposes `useEntitlement()` with status + purchase + restore, and fires a resume-sweep callback on `inactive → active` transitions. The resume-sweep wiring lands in Task 15 — for now, the provider exposes a setter so consumers can register a callback.

Spec ref: §`lib/entitlement/provider.tsx` lines 196–222.

**Files:**

- Create: `lib/entitlement/provider.tsx`

- [ ] **Step 9.1: Implement `provider.tsx`**

```tsx
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Platform } from 'react-native';
import Purchases, { type CustomerInfo, type PurchasesOfferings } from 'react-native-purchases';
import { entitlementStatus, type EntitlementStatus } from './status';
import { readCachedStatus, writeCachedStatus } from './storage';
import { PLANS, type PlanId } from './plans';

type PurchaseResult = { ok: true } | { ok: false; reason: 'user-cancelled' | 'pending' | 'error' };

type RestoreResult = { ok: true; entitled: boolean } | { ok: false };

interface EntitlementContextValue {
  status: 'loading' | EntitlementStatus;
  customerInfo: CustomerInfo | null;
  offerings: PurchasesOfferings | null;
  refresh: () => Promise<void>;
  purchasePlan: (planId: PlanId) => Promise<PurchaseResult>;
  restore: () => Promise<RestoreResult>;
  // Callback registered by RootLayoutInner once the pipeline modules are
  // mounted. Fired on inactive→active transitions.
  registerResumeHandler: (handler: () => void | Promise<void>) => () => void;
}

const Ctx = createContext<EntitlementContextValue | null>(null);

const RC_API_KEY = process.env.EXPO_PUBLIC_RC_IOS_API_KEY ?? '';

export function EntitlementProvider({ children }: { children: ReactNode }): JSX.Element {
  // Seed from the cached file synchronously so first render has a definite
  // status. Provider sits outside the existing root `ready` guard — see
  // app/_layout.tsx changes in Task 21.
  const cachedSeed = useMemo<EntitlementStatus | 'loading'>(() => {
    return readCachedStatus() ?? 'loading';
  }, []);

  const [status, setStatus] = useState<'loading' | EntitlementStatus>(cachedSeed);
  const [customerInfo, setCustomerInfo] = useState<CustomerInfo | null>(null);
  const [offerings, setOfferings] = useState<PurchasesOfferings | null>(null);
  const previousStatus = useRef<EntitlementStatus | 'loading'>(cachedSeed);
  const resumeHandlers = useRef<Set<() => void | Promise<void>>>(new Set());

  const applyCustomerInfo = useCallback((info: CustomerInfo | null) => {
    const next = entitlementStatus(info);
    setCustomerInfo(info);
    setStatus(next);
    writeCachedStatus(next);
    const prev = previousStatus.current;
    previousStatus.current = next;
    if (next === 'active' && prev !== 'active') {
      resumeHandlers.current.forEach((h) => {
        Promise.resolve(h()).catch((err) =>
          console.warn('[entitlement] resume handler failed', err),
        );
      });
    }
  }, []);

  // Init effect.
  useEffect(() => {
    let listenerHandle: { remove: () => void } | null = null;
    let cancelled = false;
    (async () => {
      if (Platform.OS !== 'ios') {
        setStatus('inactive');
        return;
      }
      if (!RC_API_KEY) {
        console.warn('[entitlement] EXPO_PUBLIC_RC_IOS_API_KEY missing — treating as inactive');
        setStatus('inactive');
        return;
      }
      await Purchases.configure({ apiKey: RC_API_KEY });
      try {
        const info = await Purchases.getCustomerInfo();
        if (cancelled) return;
        applyCustomerInfo(info);
      } catch (err) {
        console.warn('[entitlement] initial getCustomerInfo failed', err);
        if (!cancelled) applyCustomerInfo(null);
      }
      try {
        const off = await Purchases.getOfferings();
        if (!cancelled) setOfferings(off);
      } catch (err) {
        console.warn('[entitlement] getOfferings failed', err);
      }
      listenerHandle = Purchases.addCustomerInfoUpdateListener(applyCustomerInfo);
    })();
    return () => {
      cancelled = true;
      listenerHandle?.remove();
    };
  }, [applyCustomerInfo]);

  const refresh = useCallback(async () => {
    try {
      const info = await Purchases.getCustomerInfo();
      applyCustomerInfo(info);
    } catch (err) {
      console.warn('[entitlement] refresh failed', err);
    }
  }, [applyCustomerInfo]);

  const purchasePlan = useCallback(
    async (planId: PlanId): Promise<PurchaseResult> => {
      const plan = PLANS.find((p) => p.id === planId);
      if (!plan) return { ok: false, reason: 'error' };
      try {
        const off = offerings ?? (await Purchases.getOfferings());
        const pkg = off.current?.availablePackages.find(
          (p) => p.product.identifier === plan.productId,
        );
        if (!pkg) return { ok: false, reason: 'error' };
        await Purchases.purchasePackage(pkg);
        return { ok: true };
      } catch (err: unknown) {
        const e = err as { userCancelled?: boolean; code?: string };
        if (e?.userCancelled) return { ok: false, reason: 'user-cancelled' };
        if (e?.code === 'PURCHASE_PENDING_ERROR') return { ok: false, reason: 'pending' };
        return { ok: false, reason: 'error' };
      }
    },
    [offerings],
  );

  const restore = useCallback(async (): Promise<RestoreResult> => {
    try {
      const info = await Purchases.restorePurchases();
      applyCustomerInfo(info);
      return { ok: true, entitled: entitlementStatus(info) === 'active' };
    } catch (err) {
      console.warn('[entitlement] restore failed', err);
      return { ok: false };
    }
  }, [applyCustomerInfo]);

  const registerResumeHandler = useCallback((handler: () => void | Promise<void>) => {
    resumeHandlers.current.add(handler);
    return () => {
      resumeHandlers.current.delete(handler);
    };
  }, []);

  const value = useMemo<EntitlementContextValue>(
    () => ({
      status,
      customerInfo,
      offerings,
      refresh,
      purchasePlan,
      restore,
      registerResumeHandler,
    }),
    [status, customerInfo, offerings, refresh, purchasePlan, restore, registerResumeHandler],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useEntitlement(): EntitlementContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useEntitlement must be called inside <EntitlementProvider>');
  return v;
}
```

- [ ] **Step 9.2: Verify typecheck**

```bash
npx tsc --noEmit
```

Expected: clean. (`react-native-purchases` types should be picked up automatically.)

- [ ] **Step 9.3: Commit**

```bash
git add lib/entitlement/provider.tsx
git commit -m "feat(entitlement): EntitlementProvider with RC init and resume hook"
```

---

## Task 10: DB — additive migration for `*_paused_reason` columns

**Goal:** Add three nullable text columns — `sources.extraction_paused_reason`, `sources.url_fetch_paused_reason`, `places.enrichment_paused_reason` — so 401-paused rows can be marked without changing the existing CHECK enums. (`pending_imports` is intentionally not touched; see the divergence note at the top.)

Spec divergence note: see top of plan.

**Files:**

- Create: `modules/storage/migrations/0007_entitlement_paused_reason.ts`
- Modify: `modules/storage/migrations/index.ts`

- [ ] **Step 10.1: Write the migration**

Create `modules/storage/migrations/0007_entitlement_paused_reason.ts`:

```ts
import type { Migration } from '../db';

// Adds three nullable `*_paused_reason` columns to the pipeline tables.
// Filled with the literal `'entitlement'` when the worker returns 401;
// null otherwise. Sweep filters add `AND <col> IS NULL` so paused rows
// are skipped; the resume sweep flips them back to null when entitlement
// is re-acquired. The URL-fetch column lives on `sources` (not on
// `pending_imports`) because by the time url-fetch runs, the pending row
// has been DELETEd by `ingestPendingImports`.

export const entitlementPausedReason: Migration = {
  version: 7,
  up: async (db) => {
    await db.execAsync(`ALTER TABLE sources ADD COLUMN extraction_paused_reason TEXT`);
    await db.execAsync(`ALTER TABLE sources ADD COLUMN url_fetch_paused_reason TEXT`);
    await db.execAsync(`ALTER TABLE places ADD COLUMN enrichment_paused_reason TEXT`);
  },
};
```

- [ ] **Step 10.2: Register the migration**

Open `modules/storage/migrations/index.ts`. Find the migrations array and append:

```ts
import { entitlementPausedReason } from './0007_entitlement_paused_reason';

export const migrations: Migration[] = [
  // existing entries...
  entitlementPausedReason,
];
```

- [ ] **Step 10.3: Run the storage tests**

```bash
npm test --silent -- modules/storage
```

Expected: existing tests pass; the new column is created during fresh-DB test setup.

- [ ] **Step 10.4: Commit**

```bash
git add modules/storage/migrations/0007_entitlement_paused_reason.ts modules/storage/migrations/index.ts
git commit -m "feat(db): migration 0007 — paused_reason columns for entitlement pause"
```

---

## Task 11: Extraction — `entitlement-required` error kind

**Goal:** Extend `ExtractionErrorKind` with `entitlement-required` and route 401 from the proxy into it. Map it to `extraction_paused_reason='entitlement'` (no `extraction_status` change — that stays `'pending'` so a future resume sweep picks it up).

Spec ref: §"Pipeline error-kind: `entitlement-required`" lines 313–343.

**Files:**

- Modify: `modules/extraction/extraction.ts`
- Modify: `modules/extraction/proxy.ts`
- Modify: `modules/extraction/__tests__/proxy.test.ts` (or equivalent)
- Modify: `modules/extraction/__tests__/extraction.test.ts` (or equivalent)

- [ ] **Step 11.1: Locate the existing extractor tests**

```bash
ls modules/extraction/__tests__/
```

Identify the file that exercises the proxy-to-classification path. Most likely `proxy.test.ts` or `extraction.test.ts`. Read the relevant test to understand the existing mock-fetch shape — you'll mirror it.

- [ ] **Step 11.2: Add the failing test for 401 → `entitlement-required`**

In `modules/extraction/__tests__/proxy.test.ts` (or the file you identified), add:

```ts
test('401 from the worker classifies as entitlement-required', async () => {
  const fetchImpl = jest.fn(
    async () =>
      new Response(JSON.stringify({ error: 'entitlement-required' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
  );
  await expect(
    extractFromProxy('some ocr text', { fetch: fetchImpl, baseUrl: 'https://proxy.example.com' }),
  ).rejects.toMatchObject({
    name: 'ExtractionError',
    classification: { kind: 'entitlement-required' },
  });
});
```

(The exact signature of `extractFromProxy` depends on the existing test pattern; mirror it.)

- [ ] **Step 11.3: Run the test to verify it fails**

```bash
npm test --silent -- modules/extraction/__tests__/proxy.test.ts
```

Expected: the new test fails (current code maps 401 to `permanent`).

- [ ] **Step 11.4: Add `'entitlement-required'` to `ExtractionErrorKind`**

Open `modules/extraction/extraction.ts`. Find:

```ts
export type ExtractionErrorKind =
  | { kind: 'permanent' }
  | { kind: 'retryable' }
  | { kind: 'deferred'; retryAfterMs: number };
```

Replace with:

```ts
export type ExtractionErrorKind =
  | { kind: 'permanent' }
  | { kind: 'retryable' }
  | { kind: 'deferred'; retryAfterMs: number }
  | { kind: 'entitlement-required' }; // 401 — pause, do NOT count toward budget
```

- [ ] **Step 11.5: Route 401 in `modules/extraction/proxy.ts`**

Open `modules/extraction/proxy.ts`. Find the 4xx handling block (around line 75). Insert the 401 case **before** the generic 4xx fallback:

```ts
if (response.status === 401) {
  throw new ExtractionError('extract-entitlement-required', { kind: 'entitlement-required' });
}

if (response.status >= 400) {
  throw new ExtractionError(`extract-client-${response.status}`, { kind: 'permanent' });
}
```

- [ ] **Step 11.6: Run the proxy tests to verify they pass**

```bash
npm test --silent -- modules/extraction/__tests__/proxy.test.ts
```

Expected: all pass including the new 401 test.

- [ ] **Step 11.7: Update the extractor dispatcher to persist paused-reason**

Open `modules/extraction/extraction.ts`. Find the catch block that maps `ExtractionError` to DB state (search for `extraction_status = 'failed'` — there should be one or two write sites, around line 277). Add a branch for `entitlement-required` **before** the existing `failed` write:

```ts
} catch (err) {
  if (err instanceof ExtractionError) {
    if (err.classification.kind === 'entitlement-required') {
      await db.runAsync(
        `UPDATE sources
          SET extraction_paused_reason = 'entitlement', updated_at = ?
        WHERE id = ?`,
        [now(), sourceId],
      );
      return;     // do NOT consume a retry-budget slot
    }
    // ... existing handling for permanent/retryable/deferred
  }
}
```

(Adapt to the exact shape of the existing handler — mirror the variable names, `now()` calls, etc.)

- [ ] **Step 11.8: Update the sweep query to skip paused rows**

In the same file, find the sweep SELECT (around line 290 — `WHERE extraction_status = 'pending'`). Add an `AND extraction_paused_reason IS NULL` clause:

```ts
const rows = await db.getAllAsync(
  `SELECT id FROM sources
    WHERE extraction_status = 'pending'
      AND extraction_paused_reason IS NULL
    ORDER BY created_at ASC`,
);
```

Do the same for `runStartupRecovery` (around line 300) — the failed → pending flip should not flip rows that are paused.

- [ ] **Step 11.9: Add a `resumeEntitlementPaused()` export**

Append to `modules/extraction/extraction.ts` (or wherever public exports live in the existing extractor module — match the existing factory return shape):

```ts
async function resumeEntitlementPaused(): Promise<void> {
  await db.runAsync(
    `UPDATE sources
      SET extraction_paused_reason = NULL, updated_at = ?
    WHERE extraction_paused_reason = 'entitlement'`,
    [now()],
  );
  // Tick the in-memory queue so the rows that just became eligible run now,
  // not on the next sweep.
  void runExtractionSweep();
}
```

Add `resumeEntitlementPaused` to the `Extractor` type (around line 47) and the factory return.

- [ ] **Step 11.10: Add a resume-sweep unit test**

In `modules/extraction/__tests__/extraction.test.ts` (or the integration test file), add:

```ts
test('resumeEntitlementPaused clears the paused reason and re-runs sweep', async () => {
  const { db, extractor, mockExtract } = await freshExtractor();
  // Insert a source already in the paused state
  await db.runAsync(
    `INSERT INTO sources (id, kind, extraction_status, extraction_paused_reason,
      ocr_status, content_hash, origin, captured_at, owner_id, created_at, updated_at)
      VALUES ('s1', 'screenshot', 'pending', 'entitlement', 'done', 'h', 'manual',
      ?, 'owner', ?, ?)`,
    [new Date().toISOString(), new Date().toISOString(), new Date().toISOString()],
  );
  mockExtract.mockResolvedValueOnce({ places: [], model: 'test' });

  await extractor.resumeEntitlementPaused();
  await extractor._awaitIdle();

  const row = await db.getFirstAsync<{ extraction_paused_reason: string | null }>(
    `SELECT extraction_paused_reason FROM sources WHERE id = 's1'`,
  );
  expect(row?.extraction_paused_reason).toBeNull();
  expect(mockExtract).toHaveBeenCalledTimes(1);
});
```

(Adapt to the existing `freshExtractor` helper.)

- [ ] **Step 11.11: Run the extraction test suite**

```bash
npm test --silent -- modules/extraction
```

Expected: all tests pass.

- [ ] **Step 11.12: Commit**

```bash
git add modules/extraction/
git commit -m "feat(extraction): entitlement-required error kind + paused-state pipeline"
```

---

## Task 12: Extraction proxy — attach `X-RC-User-Id` header

**Goal:** Every `/extract` request from the app now sends the RC user ID. If the header value can't be obtained, treat it the same as a 401.

Spec ref: §"Client header attachment" lines 422–424.

**Files:**

- Modify: `modules/extraction/proxy.ts`

- [ ] **Step 12.1: Add the header**

Open `modules/extraction/proxy.ts`. `extractFromProxy(ocrText, proxyUrl, opts)` already receives the full URL (e.g. `https://….workers.dev/extract`) — do NOT rebuild it. Just add the header.

Find the existing `fetch(proxyUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, ... })` block (around line 42). Add a `getEntitlementUserId()` call above it and inject `X-RC-User-Id`:

```ts
import { getEntitlementUserId } from '@/lib/entitlement/userId';

// ... inside extractFromProxy, before the fetch():
let userId: string;
try {
  userId = await getEntitlementUserId();
} catch (err) {
  // RC not initialized or app-user-id unavailable. Pause the work and let
  // the provider's init + transition handler resume it later.
  throw new ExtractionError('extract-userid-unavailable', { kind: 'entitlement-required' });
}

response = await fetch(proxyUrl, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'X-RC-User-Id': userId,
  },
  body: JSON.stringify({ ocr_text: ocrText }),
  signal: controller.signal,
});
```

Keep the existing try/catch wrapping and abort-controller wiring around the fetch — only the call signature changes.

- [ ] **Step 12.2: Update the existing tests to mock `getEntitlementUserId`**

In `modules/extraction/__tests__/proxy.test.ts`, add at the top:

```ts
jest.mock('@/lib/entitlement/userId', () => ({
  getEntitlementUserId: jest.fn(async () => '$RCAnonymousID:0123456789abcdef0123456789abcdef'),
}));
```

- [ ] **Step 12.3: Run the proxy tests**

```bash
npm test --silent -- modules/extraction/__tests__/proxy.test.ts
```

Expected: all pass.

- [ ] **Step 12.4: Commit**

```bash
git add modules/extraction/proxy.ts modules/extraction/__tests__/proxy.test.ts
git commit -m "feat(extraction): attach X-RC-User-Id header on /extract"
```

---

## Task 13: Enrichment — `entitlement-required` + header + resume

**Goal:** Same shape as Tasks 11 and 12 applied to the enrichment pipeline.

**Files:**

- Modify: `modules/enrichment/enrichment.ts`
- Modify: `modules/enrichment/proxy.ts`
- Modify: `modules/enrichment/__tests__/enrichment.test.ts` (only test file in that folder)

- [ ] **Step 13.1: Locate the enrichment error kind**

Read `modules/enrichment/enrichment.ts` top-to-line-80. Confirm whether there's an `EnrichmentErrorKind` type analogous to `ExtractionErrorKind`. If there is, extend it the same way as Task 11. If there isn't (it's been seen using ad-hoc returns), introduce one — the same shape:

```ts
export type EnrichmentErrorKind =
  | { kind: 'permanent' }
  | { kind: 'retryable' }
  | { kind: 'deferred'; retryAfterMs: number }
  | { kind: 'entitlement-required' };
```

- [ ] **Step 13.2: Add a failing test for the 401 path**

In `modules/enrichment/__tests__/enrichment.test.ts`, add:

```ts
test('401 from the worker classifies as entitlement-required', async () => {
  // … mirror Task 11.2 shape but invoke the enrichment proxy fn
});
```

- [ ] **Step 13.3: Route 401 in `modules/enrichment/proxy.ts`**

Same shape as Task 11.5 — add the 401 branch before the generic 4xx fallback.

- [ ] **Step 13.4: Update the enrichment dispatcher to persist paused-reason**

In `modules/enrichment/enrichment.ts`, find the place that writes `enrichment_status = 'failed'` (around line 389). Add the `entitlement-required` branch above it:

```ts
if (err.classification.kind === 'entitlement-required') {
  await db.runAsync(
    `UPDATE places
      SET enrichment_paused_reason = 'entitlement', updated_at = ?
    WHERE id = ?`,
    [now(), placeId],
  );
  return;
}
```

- [ ] **Step 13.5: Skip paused rows in the per-place processor**

Unlike the extractor, `modules/enrichment/enrichment.ts` has no sweep loop — it processes one place at a time after `enqueueEnrichment(placeId)` (see `Enricher` type at `modules/enrichment/enrichment.ts:61-65` and `processOne` / load-place body around lines 137–151). Add an early return at the top of the load-place block:

```ts
const place = await loadPlace(placeId);
if (!place) return;
if (place.enrichment_paused_reason === 'entitlement') {
  // Paused — wait for the resume sweep to re-enqueue.
  return;
}
if (place.enrichment_status === 'not-found') return;
// ... existing body
```

(Adapt to the exact `loadPlace` return shape. Include the new column in its SELECT.)

- [ ] **Step 13.6: Add `resumeEntitlementPaused()` to the enrichment factory**

Since there's no sweep, the resume function clears the column and then re-enqueues each affected place ID via the existing `enqueueEnrichment()`:

```ts
async function resumeEntitlementPaused(): Promise<void> {
  const rows = await db.getAllAsync<{ id: string }>(
    `SELECT id FROM places WHERE enrichment_paused_reason = 'entitlement'`,
  );
  if (rows.length === 0) return;
  await db.runAsync(
    `UPDATE places
       SET enrichment_paused_reason = NULL, updated_at = ?
     WHERE enrichment_paused_reason = 'entitlement'`,
    [now()],
  );
  for (const r of rows) enqueueEnrichment(r.id);
}
```

Add `resumeEntitlementPaused: () => Promise<void>` to the `Enricher` type and include it in the factory return.

- [ ] **Step 13.7: Attach the header on the enrichment proxy call**

Same shape as Task 12 inside `modules/enrichment/proxy.ts`.

- [ ] **Step 13.8: Run the enrichment test suite**

```bash
npm test --silent -- modules/enrichment
```

Expected: all pass.

- [ ] **Step 13.9: Commit**

```bash
git add modules/enrichment/
git commit -m "feat(enrichment): entitlement-required + paused state + header"
```

---

## Task 14: Fetch-post — `entitlement-required` + header + resume

**Goal:** Same shape applied to the `/fetch-post` caller used during share-sheet URL ingest. By the time URL-fetch work runs, `pending_imports` rows have already been DELETEd by `ingestPendingImports` (`modules/capture/ingest.ts:81-82`); the URL-fetch state machine lives on `sources` rows in `modules/processing/processing.ts` (`processUrlFetch`, around lines 182–249). The paused column therefore lives on **`sources.url_fetch_paused_reason`** and the resume hook re-enqueues at the processing layer, not the capture layer.

**Files:**

- Modify: `modules/capture/fetchPostFromProxy.ts` (header + 401 sentinel)
- Modify: `modules/processing/processing.ts` (pause/resume logic, sweep filter)
- Modify: `modules/capture/__tests__/fetchPostFromProxy.test.ts`
- Modify: `modules/processing/__tests__/processing.test.ts` (or equivalent)

- [ ] **Step 14.1: Re-read the URL-fetch state machine**

Skim `modules/processing/processing.ts` start-to-finish (~250 lines). Identify:

- The function that enqueues / drives `processUrlFetch` (the equivalent of the extractor sweep — there will be a select-and-loop somewhere that picks up sources where url-fetch hasn't run).
- Where `processUrlFetch` is called from after a foreground refresh.
- The catch block(s) around the `await opts.fetchPost(row.url)` call.

The plan steps below assume that structure; if the actual implementation differs, mirror the shape rather than the exact line numbers.

- [ ] **Step 14.2: Add a failing test in `processing.test.ts`**

The test asserts that when `fetchPost` is mocked to throw an `EntitlementRequiredError` (the new sentinel type from step 14.3), `processUrlFetch` leaves the source with `url_fetch_paused_reason = 'entitlement'` and **does not** flip any failure status:

```ts
test('401 from fetch-post pauses the source instead of failing it', async () => {
  const { db, processing } = await freshProcessing();
  await insertSource(db, { id: 's1', kind: 'url', url: 'https://instagram.com/p/abc/' });
  processing.fetchPostMock.mockRejectedValueOnce(new EntitlementRequiredError('fetch-post'));

  await processing.processUrlFetch('s1');

  const row = await db.getFirstAsync<{ url_fetch_paused_reason: string | null }>(
    `SELECT url_fetch_paused_reason FROM sources WHERE id = 's1'`,
  );
  expect(row?.url_fetch_paused_reason).toBe('entitlement');
});
```

(Mirror the existing test harness — variable names depend on the existing fixture.)

- [ ] **Step 14.3: Add an `EntitlementRequiredError` sentinel in `fetchPostFromProxy.ts`**

`fetchPostFromProxy` already throws domain errors. Add a dedicated subclass so the processing-layer catch can distinguish it without string-matching:

```ts
export class EntitlementRequiredError extends Error {
  constructor(public readonly call: 'fetch-post' = 'fetch-post') {
    super('entitlement-required');
    this.name = 'EntitlementRequiredError';
  }
}
```

In the response-classification path (where the function inspects `response.status`), add a 401 branch above the generic 4xx:

```ts
if (response.status === 401) {
  throw new EntitlementRequiredError('fetch-post');
}
```

- [ ] **Step 14.4: Catch the sentinel in `processUrlFetch`**

In `modules/processing/processing.ts`, wrap the existing `await opts.fetchPost(row.url)` in a try/catch that handles the new error class **before** the generic failure path:

```ts
try {
  result = await opts.fetchPost(row.url);
  // ... existing success body
} catch (err) {
  if (err instanceof EntitlementRequiredError) {
    await opts.db.runAsync(
      `UPDATE sources
         SET url_fetch_paused_reason = 'entitlement', updated_at = ?
       WHERE id = ?`,
      [now(), id],
    );
    urlFetchStage.done({ pausedReason: 'entitlement' });
    return { retry: false };
  }
  // ... existing failure handling
}
```

Add the import `import { EntitlementRequiredError } from '../capture/fetchPostFromProxy';` at the top of the file.

- [ ] **Step 14.5: Skip paused sources in the URL-fetch driver**

Find the driver that picks up URL-fetch-pending sources (the analogue of the extractor sweep) in `modules/processing/processing.ts`. Add `AND url_fetch_paused_reason IS NULL` to its WHERE clause. Also include `url_fetch_paused_reason` in the row's SELECT shape so `processUrlFetch` can short-circuit if a caller invokes it directly on a paused row.

- [ ] **Step 14.6: Add `resumeUrlFetchEntitlementPaused()` to processing**

```ts
async function resumeUrlFetchEntitlementPaused(): Promise<void> {
  const rows = await opts.db.getAllAsync<{ id: string }>(
    `SELECT id FROM sources WHERE url_fetch_paused_reason = 'entitlement'`,
  );
  if (rows.length === 0) return;
  await opts.db.runAsync(
    `UPDATE sources
       SET url_fetch_paused_reason = NULL, updated_at = ?
     WHERE url_fetch_paused_reason = 'entitlement'`,
    [now()],
  );
  for (const r of rows) enqueueUrlFetch(r.id); // existing enqueue function
}
```

Add it to the public processing-module export shape (look at the existing factory return to match conventions).

- [ ] **Step 14.7: Attach the header in `fetchPostFromProxy`**

Same shape as Task 12: `await getEntitlementUserId()` and add `X-RC-User-Id` to the existing `fetch(...)` call. If `getEntitlementUserId()` rejects, throw `new EntitlementRequiredError('fetch-post')` — same effect as a server 401.

- [ ] **Step 14.8: Run both test suites**

```bash
npm test --silent -- modules/processing modules/capture
```

Expected: all pass.

- [ ] **Step 14.9: Commit**

```bash
git add modules/capture/ modules/processing/
git commit -m "feat(processing): entitlement-required pause + resume for /fetch-post"
```

---

## Task 15: Wire resume handlers into the provider

**Goal:** The three pipeline modules now expose resume functions. Register them with the provider once the app is mounted, so an `inactive → active` transition fans out to all three.

**Files:**

- Modify: `app/_layout.tsx`

> **Sequencing:** This task depends on Tasks 11, 13, 14 (which define the three resume exports) **and** Task 21 (which creates `RootLayoutInner`). Execute **after** Task 24, before Task 25. The numbering here matches dependency order — don't actually do Task 15 between Tasks 14 and 16.

- [ ] **Step 15.1: Add a one-shot effect in `RootLayoutInner` that registers resume handlers**

Inside `RootLayoutInner`:

```tsx
const { registerResumeHandler } = useEntitlement();
useEffect(() => {
  if (!ctx) return;
  const unsubs: Array<() => void> = [];
  unsubs.push(
    registerResumeHandler(async () => {
      await extractor.resumeEntitlementPaused();
    }),
  );
  unsubs.push(
    registerResumeHandler(async () => {
      await enricher.resumeEntitlementPaused();
    }),
  );
  unsubs.push(
    registerResumeHandler(async () => {
      await processing.resumeUrlFetchEntitlementPaused();
    }),
  );
  return () => unsubs.forEach((u) => u());
}, [registerResumeHandler, ctx, extractor, enricher, processing]);
```

The references to `extractor`, `enricher`, and `processing` are whatever the existing root layout uses to hold the factory results from `modules/extraction`, `modules/enrichment`, and `modules/processing`. Mirror the existing binding names — read the file before writing this hook to confirm.

- [ ] **Step 15.2: Commit**

```bash
git add app/_layout.tsx
git commit -m "feat(app): fan resume across extraction/enrichment/processing on entitlement active"
```

---

## Task 16: Paywall — import `PLANS` + read offerings

**Goal:** Replace the local `PLANS` const in `app/onboarding/paywall.tsx` with the imported config. Plan tile prices read from `useEntitlement().offerings` once available.

**Files:**

- Modify: `app/onboarding/paywall.tsx`

- [ ] **Step 16.1: Remove the local `PLANS` const**

In `app/onboarding/paywall.tsx` (lines ~23–29), delete the `type Plan = 'yearly' | 'monthly';` and the local `PLANS` const. Replace with:

```ts
import type { PurchasesPackage } from 'react-native-purchases';
import {
  PLANS,
  DEFAULT_SELECTED_PLAN,
  type PlanId,
  type PlanConfig,
} from '@/lib/entitlement/plans';
import { useEntitlement } from '@/lib/entitlement/provider';
```

- [ ] **Step 16.2: Update state to use `PlanId`**

Change `useState<Plan>('yearly')` to `useState<PlanId>(DEFAULT_SELECTED_PLAN)`.

- [ ] **Step 16.3: Render tiles from `PLANS` and offerings**

The existing tile render iterates `(['yearly', 'monthly'] as Plan[]).map(...)`. Change to `PLANS.map(...)`. Inside the map, derive `price` and `per` from the matching `PurchasesPackage`:

```tsx
const { offerings } = useEntitlement();

// inside the map:
const pkg = offerings?.current?.availablePackages.find(
  (p) => p.product.identifier === plan.productId,
);
const price = pkg?.product.priceString ?? FALLBACK_PRICES[plan.id].price;
const per = FALLBACK_PRICES[plan.id].per; // unit string stays static
const note = pkg ? deriveNoteFromPackage(pkg, plan) : FALLBACK_PRICES[plan.id].note;
```

Define `FALLBACK_PRICES` locally as a stop-gap until offerings load:

```ts
const FALLBACK_PRICES: Record<PlanId, { price: string; per: string; note: string }> = {
  yearly: { price: '$39.99', per: '/yr', note: 'Save 50%. Billed yearly after the trial.' },
  monthly: { price: '$6.99', per: '/mo', note: 'Billed monthly after the trial.' },
  weekly: { price: '$1.99', per: '/wk', note: 'Billed weekly after the trial.' },
};

function deriveNoteFromPackage(pkg: PurchasesPackage, plan: PlanConfig): string {
  // priceString is localized by RC. Compose the same human note we had before.
  return `Billed ${plan.label.toLowerCase()} after the trial.`;
}
```

- [ ] **Step 16.4: Derive trial-length copy from the active package**

The current paywall hardcodes "7 days" twice (CTA `"Start your 7-day free trial"` on line ~220 and footer `"No charge for 7 days"` on line ~227). Spec §"Trial length, pricing, and currency" requires both to come from the active intro offer, not from a string literal.

Add a helper near the top of the file:

```ts
function trialDaysFromPackage(pkg: PurchasesPackage | undefined): number | null {
  const period = pkg?.product.introPrice?.periodNumberOfUnits;
  const unit = pkg?.product.introPrice?.periodUnit;
  if (period == null || unit == null) return null;
  switch (unit) {
    case 'DAY':
      return period;
    case 'WEEK':
      return period * 7;
    case 'MONTH':
      return period * 30;
    case 'YEAR':
      return period * 365;
    default:
      return null;
  }
}
```

Compute the value at render and feed it into the CTA + footer copy:

```tsx
const selectedPkg = offerings?.current?.availablePackages.find(
  (p) => p.product.identifier === PLANS.find((pl) => pl.id === plan)?.productId,
);
const trialDays = trialDaysFromPackage(selectedPkg);
const trialCtaLabel = trialDays
  ? `Start your ${trialDays}-day free trial`
  : 'Start your free trial';
const trialFooterCopy = trialDays
  ? `Cancel anytime. No charge for ${trialDays} days. Then your plan auto-renews.`
  : 'Cancel anytime during the free trial. Then your plan auto-renews.';
```

Replace the literal `"Start your 7-day free trial"` on the `<PrimaryButton label=...>` with `{trialCtaLabel}`, and the footer `<Text>` body with `{trialFooterCopy}`.

- [ ] **Step 16.5: Run typecheck**

```bash
npx tsc --noEmit
```

Expected: clean.

- [ ] **Step 16.6: Commit**

```bash
git add app/onboarding/paywall.tsx
git commit -m "feat(paywall): render tiles + trial copy from RC offerings"
```

---

## Task 17: Paywall — wire `handleStartTrial`

**Goal:** Replace the `markOnboardingComplete()` stub in `handleStartTrial` with a real `purchasePlan()` call.

**Files:**

- Modify: `app/onboarding/paywall.tsx`

- [ ] **Step 17.1: Rewrite `handleStartTrial`**

Replace the existing function (around line 55) with the snippet below. Note `showToast` takes an object `{ kind, message }` — see `lib/toast/toast.ts:14-19`:

```tsx
import { showToast } from '@/lib/toast/toast';

const [busy, setBusy] = useState(false);
const { purchasePlan } = useEntitlement();

async function handleStartTrial() {
  if (busy) return;
  setBusy(true);
  void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  const result = await purchasePlan(plan);
  setBusy(false);
  if (result.ok) {
    markOnboardingComplete();
    exitOnboarding();
    return;
  }
  if (result.reason === 'user-cancelled') return; // silent
  showToast({ kind: 'error', message: "Couldn't start your trial. Try again." });
}
```

- [ ] **Step 17.2: Disable both CTAs while busy**

Pass `disabled={busy}` to the `<PrimaryButton>` and to the restore `<Pressable>` (next task).

- [ ] **Step 17.3: Commit**

```bash
git add app/onboarding/paywall.tsx
git commit -m "feat(paywall): wire Start trial CTA to RevenueCat purchase"
```

---

## Task 18: Paywall — wire `handleRestore`

**Files:**

- Modify: `app/onboarding/paywall.tsx`

- [ ] **Step 18.1: Rewrite `handleRestore`**

```tsx
const { restore } = useEntitlement();

async function handleRestore() {
  if (busy) return;
  setBusy(true);
  void Haptics.selectionAsync();
  const result = await restore();
  setBusy(false);
  if (result.ok && result.entitled) {
    markOnboardingComplete();
    exitOnboarding();
    return;
  }
  if (result.ok) {
    showToast({ kind: 'success', message: 'No purchases to restore.' });
    return;
  }
  showToast({ kind: 'error', message: 'Restore failed. Check your connection.' });
}
```

- [ ] **Step 18.2: Commit**

```bash
git add app/onboarding/paywall.tsx
git commit -m "feat(paywall): wire Restore link to RevenueCat restorePurchases"
```

---

## Task 19: Paywall — `mode=lapse` route param + dev-only `x`

**Goal:** Honor the new `?mode=lapse` route param: it swaps the headline and hides the `x` in production. The `x` becomes dev-only in both modes.

Spec ref: §`app/onboarding/paywall.tsx` changes lines 224–257.

**Files:**

- Modify: `app/onboarding/paywall.tsx`

- [ ] **Step 19.1: Read the route param**

Near the top of `PaywallScreen`:

```tsx
import { useLocalSearchParams } from 'expo-router';

const params = useLocalSearchParams<{ mode?: 'first-run' | 'lapse' }>();
const isLapseMode = params.mode === 'lapse';
```

- [ ] **Step 19.2: Swap the headline**

Replace the headline derivation (around line 51) with:

```tsx
const headline = isLapseMode
  ? 'Welcome back to Trip Pocket'
  : answers.destination
    ? PAYWALL_HEADLINE[answers.destination]
    : FALLBACK_HEADLINE;
```

- [ ] **Step 19.3: Make the `x` dev-only**

Wrap the close `Pressable` block (around lines 103–114) in `{__DEV__ && (...)}`:

```tsx
{
  __DEV__ && (
    <Pressable
      onPress={() => {
        markOnboardingComplete();
        exitOnboarding();
      }}
      accessibilityRole="button"
      accessibilityLabel="Close paywall"
      hitSlop={12}
      className="h-9 w-9 items-center justify-center"
    >
      <Icon name="xmark" size={18} tintColor={colors.textMuted} />
    </Pressable>
  );
}
```

- [ ] **Step 19.4: Run typecheck + lint**

```bash
npx tsc --noEmit && npx expo lint app/onboarding/paywall.tsx
```

Expected: clean.

- [ ] **Step 19.5: Commit**

```bash
git add app/onboarding/paywall.tsx
git commit -m "feat(paywall): mode=lapse headline and dev-only close x"
```

---

## Task 20: Smoke run the new paywall flow in a dev build

**Goal:** Manual checkpoint before touching the root layout. Confirm the paywall renders correctly, the offerings load, and `purchasePlan()` opens the StoreKit sheet (you can cancel — we're just confirming the SDK wiring).

- [ ] **Step 20.1: Build a dev client**

```bash
APP_VARIANT=development npx expo run:ios
```

- [ ] **Step 20.2: Reset onboarding so the paywall shows**

In a debug session or via the Settings → Replay onboarding affordance (if present), trigger the paywall:

```bash
# From a fresh install, the paywall shows at the end of onboarding. Walk
# through the 6-screen flow and reach the paywall.
```

- [ ] **Step 20.3: Confirm offerings render**

The three plan tiles should show **real localized prices** within ~one second of paywall mount (offerings load). Yearly should show the BEST VALUE badge.

- [ ] **Step 20.4: Confirm the purchase sheet opens**

Tap "Start your 7-day free trial". Apple's purchase sheet should appear. Cancel — we're not testing the full purchase yet.

- [ ] **Step 20.5: Confirm dev `x` still exits**

Tap the `x` in the top-right (visible in dev). The app should drop into `(tabs)`. (The lapse gate isn't wired yet — Task 21–23 — so there's no bounce-back at this point.)

If any of these don't work, fix before moving to Task 21. Common issues:

- Offerings empty → check that App Store Connect product status is "Ready to Submit" or "Approved" and the bundle ID matches.
- Purchase sheet errors → confirm sandbox tester is signed in (Settings → Developer → Sandbox Apple Account).

No commit — this is a manual checkpoint.

---

## Task 21: Root layout — split `RootLayout` / `RootLayoutInner`

**Goal:** Move the `<EntitlementProvider>` mount above the `ready` guard so RC initialization happens in parallel with the DB boot. Existing logic lives in `RootLayoutInner`.

Spec ref: §`app/_layout.tsx` changes lines 259–311.

**Files:**

- Modify: `app/_layout.tsx`

- [ ] **Step 21.1: Extract `RootLayoutInner`**

In `app/_layout.tsx`:

1. Rename the existing default-export function `RootLayout` to `RootLayoutInner` (do not yet make it default).
2. Add a new default-export `RootLayout` that wraps `RootLayoutInner` in `<EntitlementProvider>`:

```tsx
import { EntitlementProvider } from '@/lib/entitlement/provider';

export default function RootLayout() {
  return (
    <EntitlementProvider>
      <RootLayoutInner />
    </EntitlementProvider>
  );
}

function RootLayoutInner() {
  // ... all existing hooks and JSX
}
```

- [ ] **Step 21.2: Confirm typecheck**

```bash
npx tsc --noEmit
```

Expected: clean.

- [ ] **Step 21.3: Run the app**

```bash
APP_VARIANT=development npx expo run:ios
```

Confirm the app still boots, onboarding still appears on first launch, and (tabs) is reachable. No behavioral change yet.

- [ ] **Step 21.4: Commit**

```bash
git add app/_layout.tsx
git commit -m "refactor(layout): split RootLayout to mount EntitlementProvider above ready guard"
```

---

## Task 22: Root layout — splash-hide waits for entitlement status

**Goal:** A lapsed user opening the app cold should see splash → paywall, not splash → (tabs) → paywall. The splash-hide effect now waits for `status` to leave `'loading'`.

**Files:**

- Modify: `app/_layout.tsx`

- [ ] **Step 22.1: Read `useEntitlement()` inside `RootLayoutInner`**

Near the top of `RootLayoutInner`:

```tsx
const { status, refresh } = useEntitlement();
```

- [ ] **Step 22.2: Update the splash-hide effect**

Find the existing splash-hide effect (around the original lines 226–239). Add a status guard:

```tsx
useEffect(() => {
  if (!ready || splashHidden) return;

  // If we already know onboarding is needed, don't wait on entitlement —
  // first-run owns the modal regardless of status.
  if (needsOnboarding) {
    router.push('/onboarding');
    const t = setTimeout(() => {
      void SplashScreen.hideAsync();
      setSplashHidden(true);
    }, 400);
    return () => clearTimeout(t);
  }

  // Onboarding is complete. Hold the splash until entitlement resolves so
  // a lapsed user goes splash → paywall, not splash → (tabs) → paywall.
  if (status === 'loading') return;

  void SplashScreen.hideAsync();
  setSplashHidden(true);
}, [ready, needsOnboarding, splashHidden, router, status]);
```

- [ ] **Step 22.3: Commit**

```bash
git add app/_layout.tsx
git commit -m "feat(layout): hold splash until entitlement status resolves"
```

---

## Task 23: Root layout — lapse gate effect

**Goal:** When status is `inactive` after onboarding is done, push the lapse paywall. Use `router.replace` plus a pathname guard to avoid stacked modals on re-fires. Skip in `__DEV__` so the dev `x` retains its meaning.

Spec ref: §`app/_layout.tsx` changes lines 284–299.

**Files:**

- Modify: `app/_layout.tsx`

- [ ] **Step 23.1: Add the gate effect**

Inside `RootLayoutInner`, near the other root-level effects:

```tsx
import { usePathname } from 'expo-router';

const pathname = usePathname();

useEffect(() => {
  if (__DEV__) return;
  if (!ready) return;
  if (needsOnboarding) return;
  if (status === 'loading') return;
  if (status !== 'inactive') return;
  if (pathname.startsWith('/onboarding/paywall')) return;
  router.replace('/onboarding/paywall?mode=lapse');
}, [ready, needsOnboarding, status, pathname, router]);
```

- [ ] **Step 23.2: Commit**

```bash
git add app/_layout.tsx
git commit -m "feat(layout): lapse-gate paywall on inactive entitlement"
```

---

## Task 24: Root layout — foreground refresh

**Goal:** When the app returns from the background, re-check entitlement so a canceled-in-Settings subscription gates the user immediately on the next foreground.

**Files:**

- Modify: `app/_layout.tsx`

- [ ] **Step 24.1: Extend the existing AppState effect**

The current `_layout.tsx` already has an AppState listener that re-runs `runForegroundIngest`. Append a `refresh()` call to the same listener (no need for a separate subscription):

Find the existing `AppState.addEventListener('change', ...)` block. Modify the handler:

```tsx
const sub = AppState.addEventListener('change', (s: AppStateStatus) => {
  if (s === 'active') {
    void runForegroundIngest(ctx.db);
    void refresh();
  }
});
```

(Adjust to the exact shape of the existing block.)

- [ ] **Step 24.2: Commit**

```bash
git add app/_layout.tsx
git commit -m "feat(layout): refresh entitlement on foreground"
```

---

## Task 25: Device E2E — purchase, kill, restore, lapse

**Goal:** Production-config build on a real device with the sandbox tester. Run the four happy-path scenarios from the spec's testing strategy.

Spec ref: §"Testing strategy" → "Device manual" lines 454–460.

**Files:**

- None (manual)

- [ ] **Step 25.1: Build a production-config TestFlight build**

```bash
eas build --platform ios --profile production
```

When the build is ready, submit to TestFlight via App Store Connect (or `eas submit`).

- [ ] **Step 25.2: Install on device, sandbox tester signed in**

Confirm Settings → Developer → Sandbox Apple Account shows the tester email.

- [ ] **Step 25.3: Scenario 1 — fresh install → trial → kill → relaunch**

1. Delete the app from the device.
2. Install from TestFlight.
3. Walk through onboarding to the paywall. Confirm **no `x` is visible**.
4. Tap "Start your 7-day free trial" → confirm Face ID on the purchase sheet → app drops into (tabs).
5. Force-kill the app.
6. Relaunch. The app should land directly in (tabs), no paywall.

Pass criteria: ✅ paywall has no x, ✅ trial-start unlocks the app, ✅ relaunch stays unlocked.

- [ ] **Step 25.4: Scenario 2 — trial expiry → lapse paywall**

1. With the trial active, foreground the app and confirm (tabs).
2. Wait for the sandbox trial to expire (sandbox 1-week trial ≈ 3 minutes at accelerated renewal). Once expired, RC reports `pro` inactive.
3. Foreground the app.
4. The paywall should slam down with the lapse headline ("Welcome back to Trip Pocket"). No `x` visible.
5. Tap Restore. If the sandbox account has any active sub, app unlocks. Otherwise, toast: "No purchases to restore."

Pass criteria: ✅ lapse paywall appears on foreground, ✅ Restore behavior matches.

- [ ] **Step 25.5: Scenario 3 — reinstall on a second device**

1. Install the TestFlight build on a second device (or after wiping the first).
2. Walk through onboarding → paywall.
3. Tap Restore. The app should unlock (RC links the sandbox Apple ID to the existing entitlement).

Pass criteria: ✅ Restore unlocks without re-purchasing.

No commit — manual checkpoint. Note results in your test journal.

---

## Task 26: Device E2E — paused-state recovery

**Goal:** Exercise the new `entitlement-required` pipeline path: import a URL while un-entitled, confirm it stays paused, subscribe, watch it resume.

Spec ref: §"Testing strategy" device scenario 5 line 459.

**Files:**

- None (manual)

- [ ] **Step 26.1: Set up the un-entitled state**

On the dev iPhone with the **development build**:

1. Cancel any active sandbox subscription (App Store Connect → Sandbox Testers → the tester → Cancel subscription, then accelerate renewal).
2. Reset the app: delete and reinstall the dev build.
3. Walk through onboarding to the paywall, tap the dev `x` to drop into (tabs).
4. Confirm `useEntitlement().status === 'inactive'` (visible in a debug log or via React DevTools).

- [ ] **Step 26.2: Import an IG URL via share sheet**

1. Open Instagram, share any post → Trip Pocket → pick a trip.
2. Trip Pocket should accept the import.

- [ ] **Step 26.3: Confirm the source is paused**

By the time the worker call fires, `ingestPendingImports` has already moved the row into `sources` (and DELETEd the pending row). Run:

```sql
SELECT id, url_fetch_paused_reason
FROM sources
WHERE kind = 'url'
ORDER BY created_at DESC LIMIT 1;
```

Expected: `url_fetch_paused_reason = 'entitlement'`.

- [ ] **Step 26.4: Subscribe via the paywall**

1. Trigger the paywall (Settings → Replay onboarding, or by clearing `onboarding-complete.txt`).
2. Tap "Start trial" with the sandbox account.

- [ ] **Step 26.5: Confirm the paused row resumes**

1. Within a few seconds (the customer-info listener fires, the resume hook runs), the `url_fetch_paused_reason` should be `NULL` and the source should progress through fetch-post → OCR → extraction → enrichment.

2. Re-run the SQL:

   ```sql
   SELECT id, url_fetch_paused_reason FROM sources WHERE id = '<the-id>';
   ```

Pass criteria: ✅ row's `url_fetch_paused_reason` is `NULL`, ✅ the source eventually becomes a place tile on the home grid.

No commit — manual checkpoint.

---

## Task 27: Pre-submit checklist

**Goal:** Final sweep before submitting the v1.0 build to App Store Review. No code changes — this is a verification list.

- [ ] **Step 27.1: App Store Connect — products approved**

All three subscription products (`trip_pocket_pro_weekly`, `_monthly`, `_yearly`) are in **Approved** or **Ready to Submit** status. Each has a 7-day intro free trial attached.

- [ ] **Step 27.2: App Store Connect — pricing confirmed**

Final launch prices entered for each tier and locale. (PRODUCT.md said "decided at launch from beta data" — confirm the numbers with whoever owns pricing.)

- [ ] **Step 27.3: RevenueCat dashboard — entitlement and offering live**

`pro` entitlement attached to all three products; `default` offering marked Current.

- [ ] **Step 27.4: Worker — `RC_REST_API_KEY` set in production**

```bash
wrangler secret list --env production
```

Expected: `RC_REST_API_KEY` present.

- [ ] **Step 27.5: Production build — `x` not visible on paywall**

Install the production-config TestFlight build, walk to paywall, confirm there is **no `x`** in the top-right corner.

- [ ] **Step 27.6: Terms + Privacy links resolve**

Tap each link on the paywall (`https://trippocket.app/terms`, `https://trippocket.app/privacy`). Both must return a real document — these are in the open-items list of the spec; resolve them before submit.

- [ ] **Step 27.7: Run the full test suite one more time**

```bash
npm test --silent && npm test --silent --prefix workers/extract-proxy && npx tsc --noEmit && npx expo lint
```

Expected: all green.

- [ ] **Step 27.8: Tag the release**

```bash
git tag -a v1.0-paywall -m "Paywall, IAP, and entitlement gate"
git push --tags
```

---

## Reference

- Spec: `docs/superpowers/specs/2026-05-14-paywall-and-entitlement-gate-design.md`
- Roadmap: `docs/ROADMAP.md` §v1.0
- Product context: `docs/PRODUCT.md` §business model
- Telemetry follow-up (not in this plan): `docs/superpowers/specs/2026-05-12-telemetry-design.md`
- TestFlight pipeline (already shipped): `docs/superpowers/specs/2026-05-11-testflight-pipeline-design.md`
