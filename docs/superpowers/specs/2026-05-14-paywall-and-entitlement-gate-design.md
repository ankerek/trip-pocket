# Paywall, IAP, and entitlement gate — design

**Status:** approved (2026-05-14) · ready for implementation plan
**Replaces:** the two `// TODO(@cong)` stubs in `app/onboarding/paywall.tsx` (lines 57 and 66) and the open-access posture of the Cloudflare extraction proxy.
**Roadmap:** closes the StoreKit/RevenueCat, entitlement-gate, and proxy-auth bullets in `docs/ROADMAP.md` §v1.0.

## Why

v1.0 ships behind a paywall from day one (PRODUCT.md §business model). The pieces this spec wires up are the three the roadmap calls out:

1. **Real purchases.** The onboarding paywall today fakes a purchase by calling `markOnboardingComplete()`; both CTAs do the same thing whether the user "subscribes" or taps Restore. Anyone reaching the paywall gets the app for free.
2. **A lock that holds.** There's no entitlement check anywhere — once `onboarding-complete.txt` exists, the app stays unlocked forever, even if the user later cancels their subscription or never had one.
3. **A protected proxy.** `workers/extract-proxy/` serves `/extract` and `/enrich` open to anyone with the URL. Trial-active and subscribed users should be the only callers once the gate is real.

## Scope

In scope:

- Wire RevenueCat (`react-native-purchases`) into the app and the existing onboarding paywall screen.
- Support up to three plan tiles on the paywall (weekly, monthly, yearly) driven by a single config array — actual selection (2 of 3 vs. all 3) deferred to a config edit, not a code change.
- Add an app-root entitlement gate that re-checks on launch + on every foreground and presents a non-dismissible paywall when entitlement is inactive.
- Add a header-based RevenueCat entitlement check on `workers/extract-proxy/` `/extract` and `/enrich` (not `/photo/:name` — see Decisions below).
- Per-launch RC client-side cache file so cold launch can render the right surface without an unauthenticated flash.

Not in scope:

- Telemetry wiring. PostHog events at the relevant call sites are stubbed via the abstraction defined in `2026-05-12-telemetry-design.md` so they become a no-op when that spec lands; no PostHog SDK installed here.
- Pricing decisions, product IDs, and intro-offer length. All configured in App Store Connect and consumed via `Purchases.getOfferings()`; the code never hardcodes a price or a trial length.
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

**In `__DEV__` the lapse gate is suppressed.** Otherwise the dev-only `x` would be defeated by the gate. The gate code wraps in `if (__DEV__) return;`. Production behavior is unchanged.

Mode is controlled by a route param (`first-run` vs. `lapse`) for headline copy and for whether the back/dismiss gesture is intercepted by the navigator config.

**Proxy gating: header-based RevenueCat REST lookup with edge cache.** Worker reads `X-RC-User-Id` on `/extract` and `/enrich`, looks up the subscriber via `GET https://api.revenuecat.com/v1/subscribers/{user_id}` using a server-side RC REST key, checks `entitlements.pro.expires_date > now`, caches the boolean for **60 seconds** in `caches.default`. On miss → `401 entitlement-required`. The 60s cache is the latency-vs-revocation tradeoff: revoked users keep working at most one extra minute, which is acceptable for an LLM-extraction proxy.

**`/photo/:name` stays unauthenticated.** Gating it would require minting signed URLs that the React Native `Image` component carries through its disk cache, and a cache miss after a subscription lapse would visibly break already-saved place tiles. The endpoint is already a cost-bounded resize proxy. Promoted to a follow-up if abuse appears in logs.

**Anonymous-only identity for v1.0.** RC generates `$RCAnonymousID:<uuid>` on first launch. We never call `Purchases.logIn()`. The downside is that a user who reinstalls without "Restore" loses their entitlement linkage — Apple's restore flow recovers it. Acceptable; sign-in is post-v1.0.

## Architecture

```
┌──────────────────────── App ────────────────────────┐
│                                                      │
│   app/_layout.tsx                                    │
│     ├── EntitlementProvider  (init RC, expose hook)  │
│     │     ↓                                          │
│     │   useEntitlement()  →  status, refresh,        │
│     │                          purchasePlan, restore │
│     │                                                │
│     └── Root gate                                    │
│         if onboarding done && status === 'inactive': │
│           push /onboarding/paywall?mode=lapse        │
│         on AppState 'active' → refresh()             │
│                                                      │
│   app/onboarding/paywall.tsx                         │
│     mode='first-run' (default)                       │
│       Plan tiles ← getOfferings()                    │
│       Start trial → purchasePlan()                   │
│       Restore    → restore()                         │
│       x (close)  visible                             │
│     mode='lapse'                                     │
│       Same UI minus the x; minus destination headline│
│                                                      │
└──────────────────────────────────────────────────────┘
                          │
                          │ X-RC-User-Id: $RCAnonymousID:…
                          ↓
┌────────────── Cloudflare Worker (extract-proxy) ─────┐
│                                                      │
│   /extract, /enrich:                                 │
│     requireEntitlement(request, env)                 │
│       cache.match(userId, 60s)                       │
│       ↓ miss                                         │
│       RC REST: GET /v1/subscribers/{id}              │
│       check entitlements.pro.expires_date > now      │
│       cache.put(userId, bool)                        │
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
| `lib/proxy/client.ts` (or wherever extract/enrich callers live) | edit | Attach `X-RC-User-Id` header on every request; treat 401 as a hard "not entitled" error class |
| `workers/extract-proxy/src/entitlement.ts` | new | `requireEntitlement(request, env)` middleware + RC REST + 60s edge cache |
| `workers/extract-proxy/src/index.ts` | edit | Wrap `handleExtract` and `handleEnrich` in `requireEntitlement` |
| `workers/extract-proxy/wrangler.toml` | edit | Document `RC_REST_API_KEY` secret + `RC_PROJECT_ID` var |
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
export const PLANS: PlanConfig[] = [
  { id: 'yearly',  productId: 'trip_pocket_pro_yearly',  label: 'Yearly',  badge: 'BEST VALUE' },
  { id: 'monthly', productId: 'trip_pocket_pro_monthly', label: 'Monthly' },
  { id: 'weekly',  productId: 'trip_pocket_pro_weekly',  label: 'Weekly' },
];

export const DEFAULT_SELECTED_PLAN: PlanId = 'yearly';
```

### `lib/entitlement/storage.ts`

Mirrors `lib/onboarding/storage.ts`. Persists last-known status to `Paths.document/entitlement-status.txt` so cold launch can render the right surface without an authenticated round-trip first. The value is advisory — the EntitlementProvider always re-fetches and overwrites.

```ts
export function readCachedStatus(): EntitlementStatus | null;
export function writeCachedStatus(status: EntitlementStatus): void;
```

### `lib/entitlement/userId.ts`

Wraps `Purchases.getAppUserID()` with a synchronous-friendly cached read for the header attachment in `lib/proxy/client.ts`. The first call after launch blocks; subsequent reads are cached.

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
4. Subscribe to customer-info updates → recompute + persist on every change.
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

- Wrap the existing tree in `<EntitlementProvider>`. Place it outside `<OnboardingProvider>` so entitlement state survives entering/exiting onboarding.
- Add `useEntitlement()` read in the same component that already handles `needsOnboarding`. New gate runs after first-run onboarding has been completed:

  ```
  useEffect(() => {
    if (__DEV__) return;                    // dev `x` would otherwise be defeated
    if (!ready) return;
    if (needsOnboarding) return;            // first-run owns the modal
    if (status === 'loading') return;       // wait for RC
    if (status === 'inactive') {
      router.push('/onboarding/paywall?mode=lapse');
    }
  }, [ready, needsOnboarding, status]);
  ```

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

### `workers/extract-proxy/src/entitlement.ts` (new)

```ts
export interface EntitlementEnv {
  RC_REST_API_KEY: string;
  RC_PROJECT_ID: string;
}

const CACHE_TTL_SECONDS = 60;
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
  if (!env.RC_REST_API_KEY) {
    console.error('extract-proxy: RC_REST_API_KEY missing');
    return { ok: false, response: jsonError('server-misconfigured', 500) };
  }

  const cacheKey = new Request(`https://cache.local/rc/${userId}`);
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
    // Fail open on RC outage? No — fail closed: paying users see a transient
    // error toast, free riders never get a window. 503 so the client retries.
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

Top of `handleExtract` and `handleEnrich` (inside `handleEnrich`'s file actually — same pattern):

```ts
const gate = await requireEntitlement(request, env);
if (!gate.ok) return gate.response;
// existing handler body
```

`/photo/:name` (`handlePhoto`) is not touched.

### Client header attachment

The fetch call sites for `/extract` and `/enrich` need the header. Implementation plan locates them (there should be 2–3 callers between source ingest and place enrichment) and centralizes the header attachment in whichever module holds the proxy base URL. Header value: `await getEntitlementUserId()`. Failure to read the ID (e.g. RC not yet initialized): skip the request and surface the existing "extraction queued" status — the next foreground will retry once the provider has the ID.

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
   - Get the **REST API key** (server-side, *secret*) from RC. Store as a Cloudflare Worker secret: `wrangler secret put RC_REST_API_KEY` in `workers/extract-proxy/`. Set `RC_PROJECT_ID` as a plain var in `wrangler.toml`.

   **Done when:** EAS Secrets shows the public key; `wrangler secret list` shows `RC_REST_API_KEY`; `wrangler.toml` documents `RC_PROJECT_ID`.

4. **Sandbox tester** in App Store Connect (Users and Access → Sandbox Testers). One tester account is enough for TestFlight; the same account can repeat purchases as long as the StoreKit subscription speed is set to accelerated. **Done when:** signed into Settings → Developer → Sandbox Apple Account on the test device.

## Testing strategy

- **Unit:** `entitlementStatus()` against synthetic `CustomerInfo` shapes (active, expired, never-purchased, missing entitlement key).
- **Unit:** `isProActive()` in the Worker against synthetic RC payloads (active, expired, missing entitlement, malformed).
- **Worker integration:** mock `fetch` to RC. Assert (a) 401 with no header, (b) 401 on inactive entitlement, (c) 200 on active, (d) cache hit on second call within 60s (single `fetch` to RC), (e) 503 on RC 5xx, (f) `/photo/:name` not gated.
- **Device manual:** TestFlight (production-config) build with sandbox tester. Run through:
  1. Fresh install → onboarding → paywall → Start trial → app unlocks → kill app → cold launch → app still unlocked.
  2. Fresh install → onboarding → paywall → no `x` visible → Start trial → app unlocks.
  3. Subscribed user → wait for sandbox auto-renew expiry → foreground → lapse paywall appears (no `x`) → tap Restore → unlock.
  4. Fresh install on a second device with the same sandbox Apple ID → onboarding → paywall → Restore → unlock.
- **Dev manual:** development build, both `x` paths exit to the app and the lapse gate doesn't fire (so QA can navigate without subscribing).
- **Worker live smoke test:** with the staging Worker, send `/extract` with no header (expect 401), with an active user ID (expect 200), with an inactive user ID (expect 401).
- **No E2E for the Apple purchase sheet.** It isn't scriptable.

## Risks and edge cases

- **RC misconfiguration in App Store Connect.** Pre-submit checklist item in the plan: verify intro-offer is attached to each product before TestFlight. Without it the trial copy lies.
- **Cold-launch flash.** Cached status file covers the common case. First-ever launch will briefly show `status: 'loading'` — the existing splash screen carries it until ready flips.
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
