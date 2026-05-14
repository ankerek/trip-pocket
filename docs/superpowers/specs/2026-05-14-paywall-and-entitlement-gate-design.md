# Paywall, IAP, and entitlement gate — design

**Status:** approved (2026-05-14) · ready for implementation plan
**Replaces:** the two `// TODO(@cong)` stubs in `app/onboarding/paywall.tsx` (lines 57 and 66) and the open-access posture of the Cloudflare extraction proxy.
**Roadmap:** closes the StoreKit/RevenueCat, entitlement-gate, and proxy-auth bullets in `docs/ROADMAP.md` §v1.0.

## Why

v1.0 ships behind a paywall from day one (PRODUCT.md §business model). The pieces this spec wires up are the three the roadmap calls out:

1. **Real purchases.** The onboarding paywall today fakes a purchase by calling `markOnboardingComplete()`; both CTAs do the same thing whether the user "subscribes" or taps Restore. Anyone reaching the paywall gets the app for free.
2. **A lock that holds.** There's no entitlement check anywhere — once `onboarding-complete.txt` exists, the app stays unlocked forever, even if the user later cancels their subscription or never had one.
3. **A protected proxy.** `workers/extract-proxy/` serves `/extract`, `/enrich`, and `/fetch-post` open to anyone with the URL. `/fetch-post` is the most cost-sensitive of the three — its fallback path dispatches to Apify (~$1.70/1000 calls). Trial-active and subscribed users should be the only callers once the gate is real.

## Scope

In scope:

- Wire RevenueCat (`react-native-purchases`) into the app and the existing onboarding paywall screen.
- Support up to three plan tiles on the paywall (weekly, monthly, yearly) driven by a single config array — actual selection (2 of 3 vs. all 3) deferred to a config edit, not a code change.
- Add an app-root entitlement gate that re-checks on launch + on every foreground and presents a non-dismissible paywall when entitlement is inactive.
- Add a header-based RevenueCat entitlement check on `workers/extract-proxy/` `/extract`, `/enrich`, and `/fetch-post` (not `/photo/:name` — see Decisions below).
- Per-launch RC client-side cache file so cold launch can render the right surface without an unauthenticated flash.
- A new pipeline error classification, `entitlement-required`, that pauses (rather than burns) queued extraction / enrichment / fetch-post work on a 401, and a resume sweep that re-runs paused work when entitlement flips back to active.

Not in scope:

- Telemetry wiring. PostHog events at the relevant call sites are stubbed via the abstraction defined in `2026-05-12-telemetry-design.md` so they become a no-op when that spec lands; no PostHog SDK installed here.
- Pricing decisions. Configured in App Store Connect; the app reads `localizedPriceString` from `Purchases.getOfferings()`. The product IDs and 7-day trial length below are specified here as the bootstrap values — they live in the App Store Connect / RC dashboards once created, and the code never hardcodes a price or a trial duration string.
- AI disclosure copy on the onboarding screens (roadmap v1.0 has it as a separate item).
- Sign-in / account system. RevenueCat anonymous IDs only (`$RCAnonymousID:<uuid>`).
- Android. iOS-first per the roadmap; the SDK supports both but no Android product setup happens here.
- Per-platform paywall A/B testing. One paywall layout.
- Promo codes, family sharing, or upgrade/downgrade flows beyond what RC handles automatically.

## Decisions

**SDK: RevenueCat over direct `expo-iap`.** Roadmap names it. The value over StoreKit-direct: (a) free below ~$2.5k MTR, (b) handles intro-offer eligibility / restore / receipt validation server-side, (c) the REST entitlement API is the cleanest path to the proxy gate. The cost is one external dependency on a hosted dashboard; acceptable for v1.0.

**Single entitlement, three optional products.** Entitlement key: `pro`. Products: `trip_pocket_pro_weekly`, `trip_pocket_pro_monthly`, `trip_pocket_pro_yearly`. The paywall renders whatever subset of the three is enabled in `lib/entitlement/plans.ts` — the user has not finalized which two or three to ship; this lets that be one config edit when they do.

**Trial length, pricing, and currency: App Store Connect, not code.** All three are part of the product / intro-offer definition. The app reads `localizedPriceString` and intro-offer details from `Purchases.getOfferings()` and renders them. There is no hardcoded "$X.XX" or "7 days" in shipped code (we keep the existing placeholder strings only as the rendered fallback during the offerings-load window).

**The close `x` is dev-only.** The current paywall has an `x` that calls `markOnboardingComplete()` and drops into the app — a developer convenience. With the lapse gate live, an `x` that "exits to the app" is a lie: the gate would bounce them right back. Two options considered:

- Production keeps the `x` but it routes to the lapse paywall (effectively a no-op for the user).
- Production hides the `x` entirely; dev keeps it.

We do the second. The `x` is rendered only when `__DEV__`, both in first-run and lapse mode. Production users never see it. Apple's review guideline allows a subscription-required app to gate the entire experience as long as the trial is clear, which it is. The system purchase sheet has its own Cancel affordance, so a visible decline path still exists on the paywall surface as a whole.

**In `__DEV__` the navigation gate is suppressed, but the Worker gate isn't.** Otherwise the dev-only `x` would be defeated by the gate. The navigation gate code wraps in `if (__DEV__) return;`. The Worker doesn't know `__DEV__` and will still 401 a dev build that hasn't subscribed via a sandbox account — that's intentional (we want one production code path on the Worker) and the new `entitlement-required` error kind means paused work resumes once a sandbox subscription is active. To exercise the extraction pipeline in dev: sign in with a sandbox Apple ID and complete the purchase flow once. The sandbox subscription stays active across launches at the accelerated renewal speed App Store Connect uses for sandbox.

Mode is controlled by a route param (`first-run` vs. `lapse`) for headline copy and for whether the back/dismiss gesture is intercepted by the navigator config.

**Proxy gating: header-based RevenueCat REST lookup with edge cache.** Worker reads `X-RC-User-Id` on `/extract`, `/enrich`, and `/fetch-post`. Validates that the header matches the RC anonymous-ID shape (`^\$RCAnonymousID:[a-f0-9]{32}$`) — anything else → `400 invalid-user-id`. Looks up the subscriber via `GET https://api.revenuecat.com/v1/subscribers/{encoded-user-id}` using a server-side RC REST key, checks `entitlements.pro.expires_date > now`, caches the boolean for **60 seconds** in `caches.default` (cache key uses `encodeURIComponent(userId)`). On miss → `401 entitlement-required`. The 60s cache is the latency-vs-revocation tradeoff: revoked users keep working at most one extra minute, which is acceptable for an LLM-extraction proxy.

**`/photo/:name` stays unauthenticated.** Gating it would require minting signed URLs that the React Native `Image` component carries through its disk cache, and a cache miss after a subscription lapse would visibly break already-saved place tiles. The endpoint is already a cost-bounded resize proxy. Promoted to a follow-up if abuse appears in logs.

**Anonymous-only identity for v1.0.** RC generates `$RCAnonymousID:<uuid>` on first launch. We never call `Purchases.logIn()`. The downside is that a user who reinstalls without "Restore" loses their entitlement linkage — Apple's restore flow recovers it. Acceptable; sign-in is post-v1.0.

## Architecture

```
┌──────────────────────── App ────────────────────────┐
│                                                      │
│   app/_layout.tsx                                    │
│     <EntitlementProvider>  (mounts BEFORE ready)     │
│       ├── init RC, read cached status, expose hook   │
│       └── on status active←inactive: resume sweep    │
│                                                      │
│     <RootLayoutInner>  (gated on ready)              │
│       useEntitlement()  →  status, refresh,          │
│                            purchasePlan, restore     │
│       Root gate:                                     │
│         if !__DEV__ && onboarding done               │
│            && status === 'inactive'                  │
│            && !alreadyOnPaywall:                     │
│           replace /onboarding/paywall?mode=lapse     │
│         on AppState 'active' → refresh()             │
│                                                      │
│   app/onboarding/paywall.tsx                         │
│     mode='first-run' (default)                       │
│       Plan tiles ← getOfferings()                    │
│       Start trial → purchasePlan()                   │
│       Restore    → restore()                         │
│     mode='lapse'                                     │
│       Headline: 'Welcome back to Trip Pocket'        │
│     x (close): rendered only in __DEV__ (both modes) │
│                                                      │
└──────────────────────────────────────────────────────┘
                          │
                          │ X-RC-User-Id: $RCAnonymousID:…
                          ↓
┌────────────── Cloudflare Worker (extract-proxy) ─────┐
│                                                      │
│   /extract, /enrich, /fetch-post:                    │
│     requireEntitlement(request, env)                 │
│       validate user-id shape                         │
│       cache.match(encodeURIComponent(id), 60s)       │
│       ↓ miss                                         │
│       RC REST: GET /v1/subscribers/{id}              │
│       check entitlements.pro.expires_date > now      │
│       cache.put(id, bool)                            │
│     → 400 invalid-user-id on bad header              │
│     → 401 entitlement-required if inactive           │
│                                                      │
│   /photo/:name: unchanged (no gate)                  │
│                                                      │
└──────────────────────────────────────────────────────┘
```

## File map

| Path | Action | Purpose |
|---|---|---|
| `lib/entitlement/provider.tsx` | new | `<EntitlementProvider>` + `useEntitlement()` hook; wraps RC SDK init |
| `lib/entitlement/status.ts` | new | Pure `entitlementStatus(customerInfo) → 'active' \| 'inactive'` |
| `lib/entitlement/plans.ts` | new | Single config array — which product IDs render as tiles, in which order |
| `lib/entitlement/storage.ts` | new | Last-known-status snapshot file (mirrors `lib/onboarding/storage.ts` pattern) |
| `lib/entitlement/userId.ts` | new | Read RC anonymous ID for the Worker header |
| `app/onboarding/paywall.tsx` | edit | Wire `handleStartTrial` + `handleRestore`; render tiles from offerings; honor `mode=lapse`; extract `PLANS` map out (it moves to `plans.ts`) |
| `app/_layout.tsx` | edit | Wrap in `<EntitlementProvider>`; add lapse-gate + AppState foreground refresh |
| `modules/extraction/proxy.ts` | edit | Attach `X-RC-User-Id` header; on 401 throw `entitlement-required` |
| `modules/extraction/extraction.ts` | edit | Add `entitlement-required` to `ExtractionErrorKind`; persist as paused (not failed); expose `resumeEntitlementPaused()` |
| `modules/enrichment/proxy.ts` | edit | Same header attachment + 401 handling |
| `modules/enrichment/enrichment.ts` | edit | Same paused-state classification |
| `modules/capture/fetchPostFromProxy.ts` | edit | Same header attachment + 401 handling |
| `modules/processing/processing.ts` | edit | Route `fetch-post` 401 into the same paused-state pipeline path |
| `workers/extract-proxy/src/entitlement.ts` | new | `requireEntitlement(request, env)` middleware + RC REST + 60s edge cache |
| `workers/extract-proxy/src/index.ts` | edit | Wrap `handleExtract`, `handleEnrich`, and `handleFetchPost` in `requireEntitlement` |
| `workers/extract-proxy/wrangler.toml` | edit | Document `RC_REST_API_KEY` secret |
| `app.config.ts` | edit | `react-native-purchases` plugin registration |
| `.env.example`, `eas.json` | edit | `EXPO_PUBLIC_RC_IOS_API_KEY` |
| `package.json` | edit | Add `react-native-purchases` |

## Module specs

### `lib/entitlement/status.ts`

Pure function, no SDK references. Lets tests run without mocking `react-native-purchases`.

```ts
import type { CustomerInfo } from 'react-native-purchases';

export type EntitlementStatus = 'active' | 'inactive';
export const ENTITLEMENT_KEY = 'pro';

export function entitlementStatus(info: CustomerInfo | null): EntitlementStatus {
  if (!info) return 'inactive';
  return info.entitlements.active[ENTITLEMENT_KEY] ? 'active' : 'inactive';
}
```

### `lib/entitlement/plans.ts`

The single source of truth for which plans render and in which order. When the user decides the launch combo, they edit one array.

```ts
export type PlanId = 'weekly' | 'monthly' | 'yearly';

export interface PlanConfig {
  id: PlanId;
  productId: string;     // App Store Connect product ID
  label: string;         // 'Weekly' | 'Monthly' | 'Yearly'
  badge?: string;        // e.g. 'BEST VALUE'
}

// Edit this array (and only this array) when launch plans are finalized.
// The first entry is the default-selected tile.
export const PLANS: PlanConfig[] = [
  { id: 'yearly',  productId: 'trip_pocket_pro_yearly',  label: 'Yearly',  badge: 'BEST VALUE' },
  { id: 'monthly', productId: 'trip_pocket_pro_monthly', label: 'Monthly' },
  { id: 'weekly',  productId: 'trip_pocket_pro_weekly',  label: 'Weekly' },
];

export const DEFAULT_SELECTED_PLAN: PlanId = PLANS[0].id;
```

### `lib/entitlement/storage.ts`

Mirrors `lib/onboarding/storage.ts`. Persists last-known status to `Paths.document/entitlement-status.txt` so cold launch can render the right surface without an authenticated round-trip first. The value is advisory — the EntitlementProvider always re-fetches and overwrites.

```ts
export function readCachedStatus(): EntitlementStatus | null;
export function writeCachedStatus(status: EntitlementStatus): void;
```

### `lib/entitlement/userId.ts`

Wraps `Purchases.getAppUserID()` with a cached read for the `X-RC-User-Id` header attachment in the three proxy callers (`modules/{extraction,enrichment,capture}/...`). The first call after RC init blocks on the SDK; subsequent reads are cached in-process.

```ts
export async function getEntitlementUserId(): Promise<string>;
```

### `lib/entitlement/provider.tsx`

Initializes RC once. Subscribes to `Purchases.addCustomerInfoUpdateListener` so changes from inside the purchase sheet flow into the hook without a manual refresh call. Exposes:

```ts
interface EntitlementContextValue {
  status: 'loading' | EntitlementStatus;
  customerInfo: CustomerInfo | null;
  offerings: PurchasesOfferings | null;
  refresh(): Promise<void>;
  purchasePlan(planId: PlanId): Promise<{ ok: true } | { ok: false; reason: 'user-cancelled' | 'pending' | 'error' }>;
  restore(): Promise<{ ok: true; entitled: boolean } | { ok: false }>;
}

export function EntitlementProvider({ children }: { children: ReactNode }): JSX.Element;
export function useEntitlement(): EntitlementContextValue;
```

Init sequence in the provider's first effect:

1. Read cached status from `storage.ts`; set `status` optimistically so render unblocks.
2. `await Purchases.configure({ apiKey: process.env.EXPO_PUBLIC_RC_IOS_API_KEY })` (iOS only check via `Platform.OS === 'ios'`; bail safely on web/Android with `status: 'inactive'`).
3. `const info = await Purchases.getCustomerInfo()`; compute status; persist via `writeCachedStatus`.
4. Subscribe to customer-info updates → recompute + persist on every change. On every status transition, if the new status is `'active'` and the previous status was `'inactive'` (or `'loading'` with a stored cached value of `'inactive'`), fire the **resume sweep** — re-enqueue any items in extraction / enrichment / fetch-post tables that are currently in the `paused-entitlement` state (see `modules/extraction/extraction.ts` changes below).
5. Pre-fetch offerings; expose to `useEntitlement`.

`purchasePlan` calls `Purchases.purchaseStoreProduct` (or `purchasePackage` if the offering shape is package-based — implementation plan decides which once we see RC's actual offering payload). User-cancel from the purchase sheet returns `{ ok: false, reason: 'user-cancelled' }` and surfaces no toast. Network/SDK error returns `{ ok: false, reason: 'error' }` and triggers the existing toast service.

### `app/onboarding/paywall.tsx` changes

- Replace the local `PLANS` const with an import from `lib/entitlement/plans.ts`.
- Plan tiles iterate over `PLANS` (1–3 entries, no UI change at 2; layout already stacks vertically with `gap: 10`).
- Each tile reads `localizedPriceString` and intro-offer copy from the corresponding `PurchasesPackage` returned by `useEntitlement().offerings`. Loading state: the tile shows the placeholder price for ~one frame, replaced once offerings resolve.
- `handleStartTrial`:
  ```
  setBusy(true)
  const result = await purchasePlan(selectedPlan)
  setBusy(false)
  if result.ok:
    markOnboardingComplete()
    exitOnboarding()
  elif result.reason === 'user-cancelled':
    // silent
  else:
    toast('Couldn't start your trial. Try again.')
  ```
- `handleRestore`:
  ```
  setBusy(true)
  const result = await restore()
  setBusy(false)
  if result.ok && result.entitled:
    markOnboardingComplete()
    exitOnboarding()
  elif result.ok:
    toast('No purchases to restore.')
  else:
    toast('Restore failed. Check your connection.')
  ```
- New route param: `useLocalSearchParams<{ mode?: 'first-run' | 'lapse' }>()`. When `mode === 'lapse'`: replace the destination-personalized headline with `'Welcome back to Trip Pocket'`; everything else identical.
- The `x` Pressable is wrapped in `if (__DEV__)` — it renders in dev builds (first-run and lapse) and is omitted entirely in production.
- `busy` state disables both CTAs and dims them; no spinner overlay, the system purchase sheet provides its own progress UI.

### `app/_layout.tsx` changes

The current root returns `null` until `ready` flips (the DB boot pipeline). If we put `<EntitlementProvider>` *inside* that return, it won't mount or start initializing RC until after `ready` — which defeats the cached-status-before-splash-hide goal. Split the component:

```
function RootLayout() {
  return (
    <EntitlementProvider>
      <RootLayoutInner />
    </EntitlementProvider>
  );
}

function RootLayoutInner() {
  // existing hooks: ready, needsOnboarding, splashHidden, etc.
  // plus new: useEntitlement() for status + refresh
}
```

`<EntitlementProvider>` now mounts immediately on first render, runs its init effect in parallel with the DB boot, and seeds `status` from the cached file synchronously so the splash-hide effect in `RootLayoutInner` can read a definite status (active / inactive / loading) at the moment it decides what to do.

In `RootLayoutInner`:

- Add `useEntitlement()` next to the existing `useMemo(() => !isOnboardingComplete(), [])`.
- The existing splash-hide effect (lines ~226–239 in current `_layout.tsx`) adds one more delay condition: if onboarding is complete and `status === 'loading'`, wait for status to resolve before hiding splash. Avoids a (tabs) flash when a lapsed user opens the app.
- New lapse gate (separate effect, runs after the splash effect):

  ```
  const pathname = usePathname();
  useEffect(() => {
    if (__DEV__) return;                    // dev `x` would otherwise be defeated
    if (!ready) return;
    if (needsOnboarding) return;            // first-run owns the modal
    if (status === 'loading') return;       // wait for RC
    if (status !== 'inactive') return;
    if (pathname.startsWith('/onboarding/paywall')) return;  // already there
    router.replace('/onboarding/paywall?mode=lapse');
  }, [ready, needsOnboarding, status, pathname, router]);
  ```

  `replace` (not `push`) so a re-fire of the effect can't stack modals. The path-prefix guard is a belt to the suspenders — `replace` is idempotent on the same route, but the guard also catches the `?mode=lapse` re-mount case.

- AppState foreground refresh:
  ```
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') void refresh();
    });
    return () => sub.remove();
  }, [refresh]);
  ```

- The onboarding-stack `Stack.Screen` config (currently `fullScreenModal` with `gestureEnabled: false`) keeps the same options for the lapse paywall — non-dismissible by gesture is exactly what we want.

### Pipeline error-kind: `entitlement-required`

The existing extraction pipeline (`modules/extraction/extraction.ts`) classifies failures as `permanent` (4xx non-429), `retryable` (5xx/timeout, 3-try budget), or `deferred` (429, re-enqueue without budget burn). A 401 from the Worker would today land in `permanent` and immediately fail the source — wrong: the user just hasn't subscribed yet, and burning the row prevents the work from resuming once they do.

Add a fourth kind:

```ts
export type ExtractionErrorKind =
  | { kind: 'permanent' }
  | { kind: 'retryable' }
  | { kind: 'deferred'; retryAfterMs: number }
  | { kind: 'entitlement-required' };   // 401 — pause, do NOT count toward budget
```

In `modules/extraction/proxy.ts`, route 401 explicitly before the generic 4xx mapping:

```ts
if (response.status === 401) {
  throw new ExtractionError('extract-entitlement-required', { kind: 'entitlement-required' });
}
if (response.status >= 400) { /* … existing permanent path … */ }
```

In the extractor's error-classification switch (the dispatcher that maps `ExtractionError` to DB state), persist `entitlement-required` rows in a paused state — concretely, set `status = 'paused-entitlement'` (new value alongside `pending`/`failed`) and do not consume a retry-budget slot. The resume sweep called from `EntitlementProvider` (see above) re-enqueues all `paused-entitlement` rows by flipping them back to `pending` and ticking the in-memory queue.

Apply the same shape to:

- `modules/enrichment/enrichment.ts` + `modules/enrichment/proxy.ts` (place enrichment pipeline mirrors extraction).
- `modules/capture/fetchPostFromProxy.ts` — the `/fetch-post` caller during share-sheet URL ingest. On 401, the import row stays in `pending_imports` with a new `paused-entitlement` marker rather than failing. Resume sweep picks it up via `runForegroundIngest`.

The resume sweep is one function exposed from each of the three modules (`resumeEntitlementPaused()`), called in sequence from the provider's transition handler. Order: extraction → enrichment → fetch-post (matches the pipeline direction).

### `workers/extract-proxy/src/entitlement.ts` (new)

```ts
export interface EntitlementEnv {
  RC_REST_API_KEY: string;
}

const CACHE_TTL_SECONDS = 60;
const USER_ID_RE = /^\$RCAnonymousID:[a-f0-9]{32}$/;
const RC_URL = (userId: string) =>
  `https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(userId)}`;

export async function requireEntitlement(
  request: Request,
  env: EntitlementEnv,
): Promise<{ ok: true; userId: string } | { ok: false; response: Response }> {
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
    // Fail closed: paying users see a transient error toast, free riders never
    // get a window. 503 so the client treats it as retryable.
    return { ok: false, response: jsonError('entitlement-check-failed', 503) };
  }
  const body = await rc.json<RCSubscriberResponse>();
  const entitled = isProActive(body);
  await cache.put(
    cacheKey,
    new Response(entitled ? '1' : '0', {
      headers: { 'cache-control': `max-age=${CACHE_TTL_SECONDS}` },
    }),
  );
  if (!entitled) return { ok: false, response: jsonError('entitlement-required', 401) };
  return { ok: true, userId };
}

function isProActive(body: RCSubscriberResponse): boolean {
  const exp = body.subscriber?.entitlements?.pro?.expires_date;
  if (!exp) return false;
  return new Date(exp).getTime() > Date.now();
}
```

### `workers/extract-proxy/src/index.ts` changes

Top of `handleExtract`, `handleEnrich`, and `handleFetchPost`:

```ts
const gate = await requireEntitlement(request, env);
if (!gate.ok) return gate.response;
// existing handler body
```

`/photo/:name` (`handlePhoto`) is not touched.

### Client header attachment

The fetch call sites for `/extract`, `/enrich`, and `/fetch-post` need the header. The three caller modules (`modules/extraction/proxy.ts`, `modules/enrichment/proxy.ts`, `modules/capture/fetchPostFromProxy.ts`) each attach the header from `await getEntitlementUserId()`. Failure to read the ID (e.g. RC not yet initialized on a very early call): treat the same as a 401 — pause the work in `paused-entitlement` and let the provider's init complete and trigger a resume sweep.

## Manual bootstrap (one-time, blocks first end-to-end test)

These are dashboard actions, not code. The implementation plan repeats them with a "done when" line each.

1. **App Store Connect** → create the three auto-renewing subscription products in a single subscription group:
   - `trip_pocket_pro_weekly`
   - `trip_pocket_pro_monthly`
   - `trip_pocket_pro_yearly`

   Attach a free intro offer of length **7 days** to each. Set prices (any value; can be edited later before submission). Submit the products for review along with the app binary. **Done when:** all three products show in App Store Connect with status "Ready to Submit" or "Approved".

2. **RevenueCat** → create the project, link the App Store shared secret (Account → Users and Roles → Keys), create an **entitlement** with identifier `pro`, attach all three products to it. Create one **offering** named `default` containing all three products as packages. **Done when:** the RC dashboard shows the entitlement `pro` with three products attached and an offering `default`.

3. **Keys**:
   - Get the **iOS Public SDK Key** from RC (Project settings → API keys). Store as `EXPO_PUBLIC_RC_IOS_API_KEY` in `.env`, `.env.example`, and EAS Secrets.
   - Get the **REST API key** (server-side, *secret*) from RC. Store as a Cloudflare Worker secret: `wrangler secret put RC_REST_API_KEY` in `workers/extract-proxy/`.

   **Done when:** EAS Secrets shows the public key; `wrangler secret list` shows `RC_REST_API_KEY`.

4. **Sandbox tester** in App Store Connect (Users and Access → Sandbox Testers). One tester account is enough for TestFlight *and* for daily dev work — the Worker gate runs in dev too, so the dev build needs a sandbox subscription to exercise extraction / enrichment / fetch-post. The same account can repeat purchases as long as the StoreKit subscription speed is set to accelerated. **Done when:** signed into Settings → Developer → Sandbox Apple Account on the test device, and a sandbox subscription has been taken at least once.

## Testing strategy

- **Unit:** `entitlementStatus()` against synthetic `CustomerInfo` shapes (active, expired, never-purchased, missing entitlement key).
- **Unit:** `isProActive()` in the Worker against synthetic RC payloads (active, expired, missing entitlement, malformed).
- **Unit:** extraction error mapper — 401 → `entitlement-required`, 429 → `deferred`, other 4xx → `permanent`, 5xx → `retryable`.
- **Unit:** resume sweep flips `paused-entitlement` rows back to `pending` and leaves other states untouched.
- **Worker integration:** mock `fetch` to RC. Assert: (a) 401 with no header, (b) 400 with malformed header, (c) 401 on inactive entitlement, (d) 200 on active, (e) cache hit on second call within 60s (single `fetch` to RC), (f) 503 on RC 5xx, (g) `/photo/:name` not gated, (h) all three gated routes (`/extract`, `/enrich`, `/fetch-post`) call `requireEntitlement`.
- **Device manual:** TestFlight (production-config) build with sandbox tester. Run through:
  1. Fresh install → onboarding → paywall → Start trial → app unlocks → kill app → cold launch → app still unlocked.
  2. Fresh install → onboarding → paywall → no `x` visible → Start trial → app unlocks.
  3. Subscribed user → wait for sandbox auto-renew expiry → foreground → lapse paywall appears (no `x`) → tap Restore → unlock.
  4. Fresh install on a second device with the same sandbox Apple ID → onboarding → paywall → Restore → unlock.
  5. **Paused-state recovery:** with the sandbox account un-subscribed, import an IG URL → row lands in `paused-entitlement` (visible in pipeline-log) → complete a sandbox purchase → foreground → row flips to `pending` → extraction runs to completion.
- **Dev manual:** development build, both `x` paths exit to the app and the navigation gate doesn't fire (QA can navigate without subscribing). Proxy calls still 401 until a sandbox subscription is taken — once active, the `paused-entitlement` rows resume.
- **Worker live smoke test:** with the staging Worker, send `/extract`, `/enrich`, `/fetch-post` each with no header (expect 401), with a malformed header (expect 400), with an active user ID (expect 200), with an inactive user ID (expect 401).
- **No E2E for the Apple purchase sheet.** It isn't scriptable.

## Risks and edge cases

- **RC misconfiguration in App Store Connect.** Pre-submit checklist item in the plan: verify intro-offer is attached to each product before TestFlight. Without it the trial copy lies.
- **Cold-launch flash.** Cached status file covers returning users: provider seeds `status` from the file synchronously on mount, before the splash hide effect runs (provider sits outside the `ready` guard). First-ever launch has no cached value — the splash effect explicitly waits for `status` to leave `'loading'` before hiding, so the user sees splash → correct surface, not splash → (tabs) → paywall flash.
- **Dev builds and the Worker gate.** The Worker doesn't know `__DEV__`, so a dev build with no sandbox subscription will 401 on every proxy call. This is intentional (one production code path on the Worker). The `entitlement-required` error kind keeps the work paused rather than burned, so once a sandbox subscription is taken, the queued work resumes via the provider's status-transition handler. Developers must keep a sandbox Apple ID signed in to exercise the pipeline.
- **RC outage.** Worker fails closed (503). Paying users see a brief extraction-failed toast and retry. Worth the simplicity vs. failing open and serving free LLM calls.
- **User reinstalls without Restore.** They land in the paywall and either tap Restore (works) or buy again (Apple blocks the duplicate purchase and routes them to Restore automatically). RC links the new install to the existing entitlement.
- **Family Sharing.** Off by default in App Store Connect; we leave it off for v1.0. RC reports a family-shared customer the same as a primary purchaser; no special handling needed.
- **Existing TestFlight users on the no-paywall build.** Their `onboarding-complete.txt` exists but they have no purchase. They'll be force-routed to the lapse paywall on first launch of the post-paywall build. Document this in the TestFlight release notes for that build.
- **Cancellation during trial.** Apple keeps service through the original 7 days; RC reports the entitlement active with `will_renew: false`. We don't need to display a "trial ending" warning in v1.0.
- **Header tampering on the Worker.** A sophisticated free rider could send a stranger's RC user ID. They'd get the stranger's entitlement state. Not exploitable in any useful way (no PII returned by the Worker, no per-user state), so not worth the signing overhead in v1.0.

## Open items intentionally deferred

- AI disclosure copy on the onboarding flow (separate v1.0 line item).
- PostHog wiring (`2026-05-12-telemetry-design.md`).
- Privacy policy + Terms URLs (currently `https://trippocket.app/{terms,privacy}` — stub).
- Promoting `/photo/:name` to authenticated if abuse appears.
