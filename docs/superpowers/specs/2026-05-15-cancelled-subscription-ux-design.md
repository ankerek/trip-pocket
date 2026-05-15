# Cancelled / Inactive Subscription UX

**Date:** 2026-05-15
**Status:** Approved for planning (revised after Codex review)

## Problem

When a user's subscription becomes inactive (cancelled, trial expired, billing
problem), the app behaves opaquely:

- The user can still open the app and reach in-app capture entry points
  (header "+" button, in-app new-trip flow, iOS Share extension).
- New sources are accepted and inserted, then silently stall at the extraction
  step because the worker returns 401 and the pipeline pauses the row via
  `*_paused_reason = 'entitlement'` while keeping `*_status = 'pending'`.
- There is no visible indication that the subscription is the cause. The
  ProcessingBanner counts these paused rows as live processing (false-positive
  spinner), list rows show no paused state, the per-source "Still processing"
  message disappears or misleads, and there is no app-level banner.
- The existing lapse-paywall auto-redirect at `app/_layout.tsx:307-315` has
  race windows on cold launch and foreground, and the `__DEV__` close button
  lets developers slip past it in testing.

The user can perceive this as: "I opened the app, added stuff, and the
spinner runs forever — no idea why."

## Goal

The app honestly communicates an inactive subscription and degrades into a
safe read-only mode:

- Existing trips and places remain browsable.
- New captures are blocked at the entry point, with the lapse paywall as the
  resume path.
- Sources that paused mid-pipeline (before this fix or because of race windows)
  show a clear "Paused — subscription required" affordance with a tap-to-resume
  CTA, and stop being counted as live processing.
- The lapse paywall stops auto-popping; entry is via a persistent banner the
  user can choose to engage with.

The first-run paywall (`mode='first-run'`) behavior during onboarding is
**unchanged** — it stays non-dismissible.

## Non-goals

- Special UI for billing-retry / grace-period states. RevenueCat still reports
  these as active entitlement, so the app treats them as active.
- "Your card failed" messaging or any billing diagnostics.
- Re-architecting the entitlement provider or extraction-pause mechanism. Both
  already work correctly; this spec adds UI surfaces and removes one redirect.
- Changes to first-run onboarding paywall behavior.

## Architecture & flow

The supporting plumbing already exists:

- `lib/entitlement/provider.tsx` resolves `active | inactive` from RC
  `CustomerInfo.entitlements.active['pro']` and refreshes on foreground. It
  seeds from a synchronous cached status at mount and overwrites on the first
  RC fetch.
- `app/_layout.tsx` mounts the provider above the ready-guard, registers
  resume handlers across extraction / enrichment / url-fetch when DB and
  pipeline modules are ready, and currently performs the lapse redirect we're
  removing.
- Per-pipeline workers (`modules/extraction/extraction.ts`,
  `modules/enrichment/`, `modules/processing/processing.ts`) pause on 401 by
  stamping `*_paused_reason = 'entitlement'` while leaving `*_status =
  'pending'`. Resume handlers null the flag and re-sweep.

What changes is the user-visible surface and the paused-row classification:
move the lapse paywall to its own root-level modal route, replace the autopop
with a banner, exclude paused rows from "processing" counts, expose paused
rows in the lists, gate the capture entry points, and add an App Group bridge
so the iOS Share extension can refuse before writing to `pending_imports`.

## Design

### 1. Entry experience

Remove the lapse-redirect effect at `app/_layout.tsx:307-315`. The app no
longer auto-navigates to the paywall when status is inactive.

Mount a new `<InactiveEntitlementBanner />` globally in `RootLayoutInner`'s
return tree, sitting between the safe-area top inset and the tab content.

**Banner visibility conditions** (all must hold):

- `useEntitlement().status === 'inactive'`
- `needsOnboarding === false` (do not show during first-run onboarding —
  new users are typically inactive and the first-run paywall already covers
  this case)
- `pathname` does not start with `/onboarding/` and does not start with
  `/paywall-lapse` (don't shadow the paywall sheet itself or onboarding
  routes)

**Banner spec:**

- Copy: **"Subscription inactive — tap to resume"** with a trailing chevron.
- Tint: amber / warning. Reuse the project's existing warning token if one
  exists; otherwise add a single new token for this color rather than
  hardcoding hex.
- Sticky and non-dismissible. The banner disappears only when status flips
  to `active` (or its visibility conditions otherwise stop holding).
- Tap target calls the shared `openLapsePaywall()` helper (see section 9).

### 2. Lapse paywall route — split from onboarding

The current `onboarding` stack is registered as `fullScreenModal` at the
root layout (`app/_layout.tsx:323-335`), and the existing close handler at
`app/onboarding/paywall.tsx:172-185` calls `markOnboardingComplete()` and
`exitOnboarding()`. Both behaviors are wrong for the lapse case — a lapse
user should not have onboarding state mutated, and the modal should be
gesture-dismissible.

**Create a new root-level route** `app/paywall-lapse.tsx`:

- Sibling of `onboarding/`, not nested inside it.
- Registered in `app/_layout.tsx` with `presentation: 'modal'`,
  `gestureEnabled: true`, `animation: 'slide_from_bottom'` (or whatever
  matches the project's other modals — match existing settings modal if
  there is one).
- Renders the same paywall UI as `app/onboarding/paywall.tsx` `mode='lapse'`
  branch. Refactor the existing paywall component so the visual/IAP body is
  a reusable component (`components/paywall/PaywallBody.tsx` or similar)
  consumed by both routes. **Do not** add another `mode` query param flip —
  the route choice carries the mode.
- **Close handler is route-local**: dismisses the modal via `router.back()`
  or `router.dismiss()` and does **not** touch onboarding completion state.
  Visible close button (X) in production, always.

The existing `app/onboarding/paywall.tsx`:

- Keeps its `mode='first-run'` behavior and presentation (still inside the
  onboarding `fullScreenModal` stack, `gestureEnabled: false`, no close
  button in production, `__DEV__` escape hatch unchanged).
- The `mode === 'lapse'` branch in the existing file is **removed** along
  with any callers that pushed to `/onboarding/paywall?mode=lapse`.

### 3. Shared `openLapsePaywall()` helper

All new entry points (banner tap, capture-gate redirects, paused-row taps)
route through one helper to prevent duplicate pushes and unify the call
site:

```ts
// e.g. lib/paywall/openLapsePaywall.ts
export function openLapsePaywall(router: Router, pathname: string): void {
  if (pathname.startsWith('/paywall-lapse')) return;
  router.push('/paywall-lapse');
}
```

(Exact signature subject to project conventions; the contract is: no-op when
already on the lapse paywall.)

### 4. New-capture entry points

All in-app capture entry points read entitlement status and route to the
lapse paywall instead of starting capture when status is `inactive`.

- **`components/HeaderCaptureButton.tsx`**: before calling
  `pickPhotosForImport(db)`, read `useEntitlement().status`. If `inactive`,
  call `openLapsePaywall()` and return. Keep the button looking enabled —
  the tap is the discovery moment, mirroring the banner tap.
- **Picker-return re-check**: `components/pickPhotos.ts`'s
  `launchImageLibraryAsync()` is async and can take an arbitrary amount of
  time while the user is in the system picker. After it returns and before
  any DB write (`runImports()` or equivalent), re-check entitlement status.
  If it flipped to `inactive` while the picker was open, discard the
  selection, call `openLapsePaywall()`, and return. **Do not** insert rows
  that would just pause anyway.
- Any in-app "new trip → add photos" flow that calls into the same picker
  path: same gate before the picker, same re-check after the picker
  returns.
- **iOS Share extension**: gated at the extension level via an App Group
  shared `UserDefaults` key. See section 5.

### 5. iOS Share extension gating via App Group

The Share extension currently always writes to `pending_imports`. It needs
to know entitlement status without running the JS bridge.

**Source of truth for editable Swift files**: `native/ShareExtension/`
(currently: `Info.plist`, `PendingImportWriter.swift`, `ShareViewController.swift`,
`TripPickerView.swift`, `TripPocketShare.entitlements`, `TripReader.swift`).
The generated copies under `ios/` are produced by
`plugins/with-share-extension.js`. **All edits must be made in
`native/ShareExtension/`**, and the config plugin must be updated whenever
new Swift files are added.

**App Group bridge — JS side** (`lib/entitlement/provider.tsx`):

- On provider mount, **before** the first RC fetch, mirror the synchronously
  cached status (from `readCachedStatus()` at `provider.tsx:49-50`) to the
  App Group `UserDefaults`. This ensures the extension has a value to read
  even if the RC fetch hasn't completed yet.
- On every `applyCustomerInfo` call, write:
  - `entitlement.status` — `"active" | "inactive"` (string)
  - `entitlement.status_updated_at` — ISO 8601 timestamp
- App Group identifier reuses whatever the existing share extension already
  uses (declared in `native/ShareExtension/TripPocketShare.entitlements` and
  in the main app's entitlements file). The planning phase will confirm and
  surface it.
- If the write fails (e.g., misconfigured entitlements), log a Sentry
  breadcrumb and continue — the extension's fail-open fallback handles it.

**Library choice (decided)**: hand-written Expo module exposing two methods
(`setString(key, value)`, optional `getString(key)`) backed by
`UserDefaults(suiteName:)`. Native surface is tiny; avoid a new dependency.
Module lives under `modules/app-group-defaults/` (name TBD).

**Extension behavior** (Swift, edited in `native/ShareExtension/`):

- On extension launch, read `entitlement.status` and
  `entitlement.status_updated_at` from the App Group `UserDefaults`.
- **Stale-value policy**: if `status_updated_at` is missing or older than
  **7 days**, treat the status as **unknown** and render the inactive view
  with copy adjusted to: **"Open Trip Pocket to sync your subscription."**
  (Rationale: a user who hasn't opened the app in a week may have changed
  subscription state without us syncing; better to ask them to open than to
  silently accept and stall the row.)
- If `status === 'inactive'` (and fresh): render a single-screen view with
  copy **"Subscription inactive. Open Trip Pocket to resume."** plus a
  **Done** button that dismisses the extension. Do **not** write to
  `pending_imports`.
- If `status === 'active'` (and fresh): existing flow unchanged.
- If `status` is missing entirely (first-ever launch before the JS has
  written): treat as `active` and let the 401 fallback (section 6) handle
  rejection downstream. This is the documented fail-open path.

### 6. Race fallback

If status was `active` when the extension wrote but flipped to `inactive`
before `ingestPendingImports()` runs, the source enters the pipeline and
pauses mid-flight via the existing 401 path. Section 7 surfaces the paused
row in the inbox.

### 7. Paused-row UI in lists and processing count

Three surfaces today either hide or mislabel paused rows. Plus the
processing count itself is wrong. Each is updated to read `*_paused_reason`
columns.

**7a. `modules/storage/processing-status.ts`** — exclude entitlement-paused
rows from live-processing count:

```ts
// Before:
export const PROCESSING_SOURCES_WHERE = `ocr_status = 'pending' OR extraction_status = 'pending'`;

// After:
export const PROCESSING_SOURCES_WHERE = `
  (ocr_status = 'pending' OR extraction_status = 'pending')
  AND extraction_paused_reason IS NULL
  AND url_fetch_paused_reason IS NULL
`;
```

Also update the `isSourceProcessing()` helper to take and check the paused
columns:

```ts
export function isSourceProcessing(s: {
  ocr_status: ProcessingStatus;
  extraction_status: ProcessingStatus;
  extraction_paused_reason: string | null;
  url_fetch_paused_reason: string | null;
}): boolean {
  if (s.extraction_paused_reason || s.url_fetch_paused_reason) return false;
  return s.ocr_status === 'pending' || s.extraction_status === 'pending';
}
```

`ProcessingBanner` then naturally stops counting paused rows. No copy
change needed for the banner itself.

**7b. Source-row components — paused chip + tap routing**:

Components that render source rows and need to expose paused state. Exact
list (verify and finalize during planning):

- `components/PlaceGrid.tsx` and `components/PlaceTile.tsx` — render places
  in trip detail and inbox. Need `enrichment_paused_reason` on `PlaceRowData`
  if a place is shown for a not-yet-enriched source. (For places, the
  relevant paused field is `enrichment_paused_reason` on `places`.)
- Source-row components in the inbox / pocket and trip detail (project
  uses `PlaceRow` for places, but pure-source rows live in inbox surfaces
  — TBD during planning).
- Storage types in `modules/storage/sources.ts` (currently lines 9-26) and
  any place row types need to include `extraction_paused_reason`,
  `url_fetch_paused_reason`, and `enrichment_paused_reason`.
- SQL projections in the affected live-queries must add the paused columns.

**Chip rendering rule**: if any of `extraction_paused_reason`,
`url_fetch_paused_reason`, or (for place rows) `enrichment_paused_reason`
equals `'entitlement'`, replace the normal status indicator with an amber
**"Paused — subscription required"** chip. Tapping the row calls
`openLapsePaywall()` instead of routing to source/place detail. Rationale:
the source's content is half-built; opening detail just exposes an
incomplete card.

**7c. `app/sources/[id]/places-found.tsx`** — expose paused state:

Extend `STATUS_SQL` to select `extraction_paused_reason` and
`url_fetch_paused_reason`:

```ts
const STATUS_SQL = `SELECT extraction_status, extraction_paused_reason,
                           url_fetch_paused_reason
                      FROM sources WHERE id = ?`;
```

Add a new branch **before** the `pending`/`failed`/empty cases:

```ts
if (status?.extraction_paused_reason === 'entitlement'
    || status?.url_fetch_paused_reason === 'entitlement') {
  return <PausedEntitlementHint onResume={() => openLapsePaywall(...)} />;
}
```

`PausedEntitlementHint` renders **"Paused — subscription required"** plus a
Resume CTA.

### 8. Resume flow

When entitlement transitions `inactive → active`:

- `lib/entitlement/provider.tsx` fires registered resume handlers.
- `app/_layout.tsx` resume fan-out calls `resumeEntitlementPaused()` on
  extractor / enricher / processor. Each nulls `*_paused_reason` and
  re-sweeps.
- Banner hides automatically (status check).
- Paused chips clear naturally as the resume handlers run; live queries
  flip rows back to live processing and they progress through the pipeline.

**8a. Cold-launch resume — late-registration replay**:

`lib/entitlement/provider.tsx` currently fires resume handlers immediately
on `inactive → active` transitions, but `app/_layout.tsx:282-301` only
registers those handlers after DB and pipeline modules are ready. A
transition that occurs during the gap is silently dropped.

Fix: when the handler-registration effect in `RootLayoutInner` runs and the
current entitlement status is already `active`, run a one-shot replay sweep
that calls each `resumeEntitlementPaused()` exactly once (idempotent — SQL
update is `WHERE paused_reason = 'entitlement'`, no-op when no rows match).
This catches:

- Cold launch when status was inactive on prior session and is active now.
- Foreground refresh that flipped status before the pipeline context was
  ready.

The replay is keyed on registration time, not on status transitions, so it
runs at most once per app session.

**8b. Resume toast — avoid race with flag clearing**:

A one-time toast **"Welcome back. Resuming your imports…"** anchored top,
auto-dismisses after ~2.5s. Triggered when status transitions `inactive →
active` and at least one row had a paused reason.

**Critical**: the resume fan-out at `app/_layout.tsx:286-298` clears flags
immediately, so checking paused-row count after the handlers run will
always be zero. The toast trigger must run **before** flags are cleared.

Implementation options (planning phase chooses):

- **Option A (preferred)**: refactor `resumeEntitlementPaused()` on each
  module to return a boolean / count indicating whether it resumed
  anything. The fan-out aggregates the result. If any module reports
  resumed work, show the toast.
- **Option B**: in `lib/entitlement/provider.tsx`, before invoking resume
  handlers on transition, query the DB for paused row count. If `> 0`,
  show the toast. (Couples provider to DB schema — less clean.)

Either way, the toast condition is computed **before or as part of** the
resume call, not after.

### 9. Edge cases — consolidated

- **Cold launch with stale cached `active` that flips to `inactive`**: app
  opens normally to last route, RC refresh resolves, banner appears,
  paused chips show up, ProcessingBanner stops counting paused rows. No
  flash of paywall.
- **Cold launch with prior inactive that is now active**: section 8a
  replay sweep handles this. Toast triggers per section 8b if there were
  paused rows.
- **Status race during share-extension write**: section 6. Fallback path
  is the existing 401 → paused row, now visible via section 7.
- **Stale share-extension status**: section 5 — 7-day staleness threshold
  routes the user to open the main app.
- **App Group write failure**: provider logs Sentry breadcrumb;
  extension's `entitlement.status` missing → fail-open to `active` → 401
  fallback. User still gets a visible paused row after ingest.
- **Cached inactive before RC fetch**: section 5 — provider mirrors
  cached status to App Group **on mount**, before the RC fetch resolves.
- **First-run paywall**: unchanged. The new `app/paywall-lapse.tsx` route
  is separate; first-run onboarding goes through `app/onboarding/paywall.tsx`
  unchanged.
- **Banner during first-run onboarding**: hidden via the
  `needsOnboarding === false` and pathname guards in section 1.
- **Multiple tap sources for the paywall**: `openLapsePaywall()` no-ops
  when already on the lapse route (section 3).
- **Picker open during status flip**: section 4 — re-check after
  `launchImageLibraryAsync()` returns.

## Files touched (preview)

Implementation plan will finalize this list. Initial inventory:

- `app/_layout.tsx` — remove lapse-redirect effect (lines 303-315);
  register new `paywall-lapse` route as `presentation: 'modal'`,
  `gestureEnabled: true`; mount `<InactiveEntitlementBanner />`; add
  one-shot late-registration replay (section 8a).
- `app/paywall-lapse.tsx` — new root-level route. Renders shared paywall
  body, with its own close handler that does **not** touch onboarding
  state.
- `app/onboarding/paywall.tsx` — drop `mode='lapse'` branch and any
  related conditional; keep first-run behavior and the `__DEV__` escape
  hatch unchanged.
- `components/paywall/PaywallBody.tsx` (or similar) — extracted shared
  paywall body used by both routes.
- `components/InactiveEntitlementBanner.tsx` — new component, visibility
  gated per section 1.
- `components/HeaderCaptureButton.tsx` — entitlement gate before picker
  and re-check after picker returns.
- `components/pickPhotos.ts` — re-check entitlement after
  `launchImageLibraryAsync()` returns (or wrap the call site with the
  re-check; planning chooses placement).
- `lib/paywall/openLapsePaywall.ts` — new shared helper (section 3).
- `lib/entitlement/provider.tsx` — mirror cached status to App Group on
  mount; write `entitlement.status` and `entitlement.status_updated_at`
  on every `applyCustomerInfo`; Sentry breadcrumb on write failure.
- `modules/storage/processing-status.ts` — exclude paused rows from
  `PROCESSING_SOURCES_WHERE`; update `isSourceProcessing()` signature.
- `modules/storage/sources.ts` — add `extraction_paused_reason` and
  `url_fetch_paused_reason` to storage types.
- Place storage types — add `enrichment_paused_reason` to row types.
- Source-row and place-row components (`components/PlaceGrid.tsx`,
  `components/PlaceTile.tsx`, `components/PlaceRow.tsx`, and any inbox
  source-row component — enumerate during planning) — accept paused
  columns; render chip; route taps to `openLapsePaywall()`.
- Live-query SQL projections in calling screens — add the paused columns.
- `app/sources/[id]/places-found.tsx` — extend `STATUS_SQL`; add paused
  branch with `PausedEntitlementHint` before existing branches.
- `components/PausedEntitlementHint.tsx` (or inline in places-found) — new.
- `native/ShareExtension/ShareViewController.swift` — read App Group
  status + `updated_at`; render inactive / stale views; skip
  `pending_imports` write when inactive or stale.
- `native/ShareExtension/TripPocketShare.entitlements` — confirm App Group
  identifier matches main app entitlements (likely no change).
- `plugins/with-share-extension.js` — update if new Swift files are added.
- `modules/app-group-defaults/` — new Expo module exposing
  `setString`/`getString` backed by `UserDefaults(suiteName:)`.
- Resume toast component — extend existing toast infra if present,
  otherwise minimal new component. Triggered from resume fan-out per
  section 8b.
- Extraction / enrichment / processing modules — return a
  resumed-count/boolean from `resumeEntitlementPaused()` to feed the
  toast trigger (section 8b option A).

## Testing approach

- Unit: entitlement gate in `HeaderCaptureButton` (active → opens picker,
  inactive → opens paywall).
- Unit: entitlement re-check after picker returns (status flips during
  picker → no DB writes, paywall opens).
- Unit: paused chip renders when any `*_paused_reason === 'entitlement'`.
- Unit: `PROCESSING_SOURCES_WHERE` and `isSourceProcessing()` exclude
  paused rows.
- Unit: resume toast triggers only on `inactive → active` transition AND
  prior paused-row presence — not on flag-cleared state.
- Unit: `openLapsePaywall()` no-ops when already on `/paywall-lapse`.
- Unit: banner visibility — hidden during first-run onboarding, hidden on
  onboarding/paywall-lapse pathnames, visible elsewhere when inactive.
- Unit: provider mirrors cached status to App Group on mount before RC
  fetch resolves.
- Unit: late-registration replay runs once when handlers register with
  `active` status; not at all when inactive.
- Integration: end-to-end with RC sandbox — simulate cancellation, verify
  banner appears, header "+" routes to paywall, paused rows show chips,
  ProcessingBanner stops spinning on paused rows, resubscribe clears
  chips and shows toast.
- Integration: cold-launch with inactive cached status, RC fetch returns
  active → replay sweep clears paused rows, toast shows.
- Manual: iOS Share extension on a real device — fresh inactive, fresh
  active, stale (>7 day) value, missing value. Verify correct view
  renders and `pending_imports` write is correctly gated.
- Manual: close button on lapse paywall — verify it dismisses without
  affecting onboarding state.

## Open questions for planning

- Exact source-row component(s) in inbox / pocket / trip detail surfaces.
  Enumerate during plan walk.
- Resume toast: identify existing toast/snackbar infrastructure in the
  codebase or build minimal new component. Check `components/` during
  plan.
- App Group identifier string — read from existing
  `TripPocketShare.entitlements` and main app entitlements during plan.
- Animation choice for lapse modal — match existing modal animations in
  the project for consistency.
