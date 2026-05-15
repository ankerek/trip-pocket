# Cancelled / Inactive Subscription UX

**Date:** 2026-05-15
**Status:** Approved for planning

## Problem

When a user's subscription becomes inactive (cancelled, trial expired, billing
problem), the app behaves opaquely:

- The user can still open the app and reach in-app capture entry points
  (header "+" button, in-app new-trip flow, iOS Share extension).
- New sources are accepted and inserted, then silently stall at the extraction
  step because the worker returns 401 and the pipeline pauses the row via
  `*_paused_reason = 'entitlement'`.
- There is no visible indication that the subscription is the cause. The
  ProcessingBanner only counts `pending` rows, list rows show no paused state,
  the per-source "Still processing" message disappears, and there is no
  app-level banner.
- The existing lapse-paywall auto-redirect at `app/_layout.tsx:303-315` has
  race windows on cold launch and foreground, and the `__DEV__` close button
  lets developers slip past it in testing.

The user can perceive this as: "I opened the app, added stuff, and nothing
processed — no idea why."

## Goal

The app honestly communicates an inactive subscription and degrades into a
safe read-only mode:

- Existing trips and places remain browsable.
- New captures are blocked at the entry point, with the lapse paywall as the
  resume path.
- Sources that paused mid-pipeline (before this fix or because of race windows)
  show a clear "Paused — subscription required" affordance with a tap-to-resume
  CTA.
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
  `CustomerInfo.entitlements.active['pro']` and refreshes on foreground.
- `app/_layout.tsx` mounts the provider above the ready-guard, fans resume
  handlers across extraction / enrichment / url-fetch when status transitions
  to active, and currently performs the lapse redirect we're removing.
- Per-pipeline workers (`modules/extraction/`, `modules/enrichment/`,
  `modules/processing/`) already pause on 401 by stamping
  `*_paused_reason = 'entitlement'` on the row and emitting `stage.done` with
  a paused reason. Resume handlers clear the flag and re-sweep.

What changes is the user-visible surface: replace one autopop with a banner,
expose paused rows in the lists, gate the capture entry points, and add an
App Group bridge so the iOS Share extension can refuse before writing to
`pending_imports`.

## Design

### 1. Entry experience

Remove the lapse-redirect effect at `app/_layout.tsx:303-315`. The app no
longer auto-navigates to the paywall when status is inactive.

Mount a new `<InactiveEntitlementBanner />` globally, sitting between the
tab content and the safe-area top inset so it is visible across every tab
and stack. Visible only when `useEntitlement().status === 'inactive'`.

Banner spec:

- Copy: **"Subscription inactive — tap to resume"** with a trailing chevron.
- Tint: amber / warning. Reuse the project's existing warning token if one
  exists; otherwise add a single new token for this color rather than
  hardcoding hex.
- Sticky and non-dismissible. The banner disappears only when status flips
  to `active`.
- Tap target opens `/onboarding/paywall?mode=lapse` as a sheet.

### 2. Lapse paywall behavior change

`app/onboarding/paywall.tsx` keeps its current `mode='lapse'` copy and CTAs.
Two behavioral changes:

- **Dismissibility is mode-conditional**. When `mode === 'lapse'`, the route
  presents as a regular `modal` (not `fullScreenModal`) with
  `gestureEnabled: true` and a visible close button in production (not gated
  on `__DEV__`). When `mode === 'first-run'`, presentation stays
  `fullScreenModal` with `gestureEnabled: false` and no close button —
  current onboarding behavior preserved.
- The `__DEV__`-only close button check (`paywall.tsx:172-185`) is replaced
  by the same `mode === 'lapse'` check.

### 3. New-capture entry points

All in-app capture entry points read entitlement status and route to the
lapse paywall instead of starting capture when status is `inactive`.

- **`components/HeaderCaptureButton.tsx`**: before calling
  `pickPhotosForImport(db)`, read `useEntitlement().status`. If `inactive`,
  `router.push('/onboarding/paywall?mode=lapse')` and return. Keep the
  button looking enabled — the tap is the discovery moment, mirroring the
  banner tap.
- Any in-app "new trip → add photos" flow that calls into the same picker
  path: same gate, in the same place where it currently triggers the
  picker.
- **iOS Share extension**: gated at the extension level via an App Group
  shared `UserDefaults` key. See section 4.

### 4. iOS Share extension gating via App Group

The Share extension currently always writes to `pending_imports`. It needs
to know entitlement status without running the JS bridge.

**App Group bridge:**

- Provider (`lib/entitlement/provider.tsx`) writes `entitlement.status`
  (string `"active" | "inactive"`) to a shared App Group
  `UserDefaults` on every `applyCustomerInfo` call.
- Provider also writes an `entitlement.status_updated_at` ISO timestamp,
  for diagnostics only (no behavioral impact).
- Library choice (TBD during planning): either a small custom Expo
  module using `UserDefaults(suiteName:)` directly, or an existing
  package such as `react-native-shared-group-preferences`. The native
  surface area is tiny — two setters — so a hand-written Expo module is
  acceptable.

**Extension behavior** (Swift, current Share extension location in
`ios/`):

- On extension launch, read `entitlement.status` from the App Group
  `UserDefaults`. Treat any missing or unreadable value as `active`
  (fail-open to the 401-pause fallback).
- If `inactive`: render a single-screen view with copy
  **"Subscription inactive. Open Trip Pocket to resume."** plus a
  **Done** button that dismisses the extension. Do **not** write to
  `pending_imports`.
- If `active`: existing flow unchanged.

**Race fallback**: if status was `active` when the extension wrote but
flipped to `inactive` before `ingestPendingImports()` runs, the source
enters the pipeline and pauses mid-flight via the existing 401 path. No
new code needed — section 5 surfaces the paused row.

### 5. Paused-row UI in lists

Three surfaces today either hide or mislabel paused rows. Each is updated
to read `*_paused_reason === 'entitlement'` and render a paused affordance.

- **Source rows** (wherever sources render in the inbox, places-found
  sheet, and trip detail — exact components to be enumerated during
  planning): if any of `extraction_paused_reason`,
  `url_fetch_paused_reason`, or (where the row represents a place)
  `enrichment_paused_reason` equals `'entitlement'`, replace the normal
  status indicator with an amber **"Paused — subscription required"**
  chip. Tapping the row routes to `/onboarding/paywall?mode=lapse`
  instead of the source detail. Rationale: the source's content is
  half-built; routing into detail just exposes an incomplete card.
- **`components/ProcessingBanner.tsx`**: unchanged. The banner is about
  live progress; per-row chips carry the paused signal. Revisit only if
  early dogfooding shows users miss the chips.
- **`app/sources/[id]/places-found.tsx`**: replace the "Still processing"
  empty state with **"Paused — subscription required"** and a Resume CTA
  that opens the lapse paywall, when the source's
  `extraction_paused_reason === 'entitlement'`.

### 6. Resume flow

Already mostly wired. When entitlement transitions `inactive → active`:

- `lib/entitlement/provider.tsx` fires registered resume handlers.
- `app/_layout.tsx` resume fan-out calls `resumeEntitlementPaused()` on
  extractor / enricher / processor. Each clears `*_paused_reason = NULL`
  and re-sweeps.
- Banner hides automatically (status check).
- Paused chips clear naturally as the resume handlers run; live queries
  flip rows back to `pending` and they progress through the pipeline.

User-visible addition: a one-time toast/snackbar
**"Welcome back. Resuming your imports…"** anchored top, auto-dismiss
after ~2.5s. Triggered when status transitions `inactive → active`
**and** there is at least one row with any `*_paused_reason = 'entitlement'`.
Suppressed otherwise to avoid a noisy toast on every renew.

### 7. Edge cases

- **Cold launch with stale cached `active` that flips to `inactive`**: app
  opens normally to last route, RC refresh resolves, banner appears,
  paused chips show up. No flash of paywall.
- **Status race during share-extension write**: documented in section 4.
  Fallback path is the existing 401 → paused row, now visible via
  section 5.
- **App Group write failure**: if the JS provider can't write to the App
  Group (e.g., misconfigured entitlements), extension fail-opens to
  `active` and the 401 fallback handles it. Surface as a Sentry breadcrumb
  on write failure for diagnostic visibility.
- **First-run paywall**: unchanged. The dismissibility flip in section 2
  is keyed on `mode === 'lapse'` specifically.

## Files touched (preview)

Implementation plan will finalize this list. Initial inventory:

- `app/_layout.tsx` — remove lapse-redirect effect; mount
  `<InactiveEntitlementBanner />`.
- `app/onboarding/paywall.tsx` — mode-conditional dismissibility and close
  button; replace `__DEV__` check with `mode === 'lapse'` check.
- `components/InactiveEntitlementBanner.tsx` — new component.
- `components/HeaderCaptureButton.tsx` — entitlement gate before picker.
- Source-row components (TBD during planning) — paused chip + tap routing.
- `app/sources/[id]/places-found.tsx` — paused empty state.
- `lib/entitlement/provider.tsx` — write `entitlement.status` and
  `entitlement.status_updated_at` to App Group `UserDefaults` on every
  `applyCustomerInfo` call.
- iOS Share extension (Swift) — read App Group status; render
  inactive-state view; skip `pending_imports` write.
- App Group entitlements / config — add a shared group identifier if not
  already present.
- New native module or chosen package for App Group `UserDefaults`
  read/write — decision in planning.
- Resume toast component or extension of existing toast infra — one-time
  toast on `inactive → active` transition.

## Testing approach

- Unit: entitlement gate in `HeaderCaptureButton` (active → opens picker,
  inactive → opens paywall).
- Unit: paused chip renders when any `*_paused_reason === 'entitlement'`.
- Unit: resume toast triggers only on `inactive → active` transition AND
  paused-row presence.
- Integration: end-to-end with RC sandbox — simulate cancellation, verify
  banner appears, header "+" routes to paywall, paused rows show chips,
  resubscribe clears chips and shows toast.
- Manual: iOS Share extension on a real device with toggled App Group
  entitlement status; verify inactive view renders and no row is written
  to `pending_imports`.

## Open questions for planning

- Exact component(s) that render source rows (multiple list surfaces —
  inbox, trip detail, places-found). Enumerate during plan.
- App Group library choice: hand-written Expo module vs existing package.
  Default: hand-written, two setters.
- Resume toast: reuse existing toast infrastructure if present, or add a
  minimal new component. Check current codebase during plan.
