# Trip Pocket — Roadmap

Solo working document. Living plan, no calendar dates. Milestones are scoped, not timed — each ships when it ships.

## How this is organized

- Milestones from **v0.1** through **v1.0**, then a **Later** parking lot.
- Inside the **active** milestone (currently v0.1), three buckets: **Now / Next / Later (this milestone)**.
- Future milestones list scope only — no internal sequencing yet.
- Anything not in a milestone or the parking lot doesn't exist.

## Stack

Default: **React Native (Expo)**. Switch to native iOS only if a specific MVP feature can't be done well in Expo. Don't spike both — start building.

---

## v0.1 — "I can use it daily" — ✅ shipped

The minimum capture/browse loop. Ugly is fine. Goal: prove that saving and re-finding a screenshot inside this app feels meaningfully better than the camera roll.

**Definition of done:** I'm using it on my own phone every day for a week without going back to Photos for the same task.

**Status (2026-05-09):** shipped. The capture loop — share-sheet (with trip picker), camera-roll import, list/grid, detail, trip CRUD, delete — works on device. v0.2 is now the active milestone; the empty-state audit folded into the v0.2 polish pass.

### Now

- [x] Expo project set up, dev build running on iPhone, repo bootstrapped.
- [x] Share-sheet target that accepts an image and saves it to app storage.
- [x] Local persistence of saved screenshots (image + minimal metadata).
- [x] Simple list/grid view of saved screenshots.
- [x] ~~One hard-coded "trip"~~ → superseded by full trip support below.

### Next (this milestone)

- [x] Trip creation + manual assign-to-trip.
- [x] "Add from camera roll" flow inside the app.
- [x] Tap-to-view full screenshot.
- [x] Delete a screenshot.
- [x] **Beyond original scope:** trip picker inside the share extension itself (was deferred from Phase 1 to Phase 2; shipped 2026-05-07). Capture-to-trip is now one tap from Photos.

### Later (this milestone)

- [x] Trip rename / delete.
- [x] Basic settings screen (version, about). (Version shown; "about" copy minimal.)
- [→] Empty state copy. Carried into v0.2 polish — some surfaces have it, full audit pending.

### Explicit non-goals for v0.1

- OCR — v0.2.
- AI categorization (place / food / activity) — v0.2 (AI-only; no manual tag editor).
- AI extraction / Places view — v0.2.
- Onboarding — v0.3.
- Any design polish.

---

## v0.2 — "Full MVP, feature-complete" — ✅ shipped

Everything PRODUCT.md calls "at launch". The app is feature-complete for the wedge — _save it before it's lost_ — plus the AI extraction layer that turns screenshots and shared posts into usable places. Not yet polished for strangers.

**Definition of done:** every "at launch" bullet from PRODUCT.md works end-to-end, capture-to-saved-in-trip is under ~5 seconds, and AI extraction reliably produces a tappable place for the obvious cases (single restaurant or POI in a screenshot or post).

**Status (2026-05-15):** shipped. Core pipeline runs end-to-end on device for both screenshot and IG/TikTok URL captures; the v0.3 polish pass is now the active milestone. Two design changes vs. the original plan:

- Schema collapsed to a places-first shape (`places` + `place_sources` junction + generalised `sources`) before any users existed; FTS5 indexes the place document, not the source document.
- Manual tagging UI is **cut**: `places.category` is populated by the AI extractor and that covers the launch-promise behaviour. No user-facing tag editor will ship in v0.2 (or v1.0). Override-the-AI-category lives in v1.x if users actually ask.

**Shipped:**

- [x] On-device OCR via Apple Vision (`modules/vision-ocr/`, Swift Expo Module).
- [x] AI extraction pipeline: Cloudflare Worker proxy fronting Gemini 2.5 Flash-Lite via Cloudflare AI Gateway. Empty result = noise classifier.
- [x] Place enrichment: Google Places + Gemini narrative through the same proxy (`/enrich`), plus a `/photo/:name` image proxy for resized venue photos. Lat/lng populates Maps deep-links. Google's `display_name` becomes canonical so "joe's pizza & bar" and "Joe's Pizza" converge after enrichment.
- [x] Dedupe by Google Place ID — `external_place_id` is the canonical identity for matching new extractions against existing rows. Forward-only; no backfill of pre-existing duplicates.
- [x] FTS5 search across place name, city, country, description, `place_sources.raw_text` (capped 2 KB per source), and `extracted_address`. Trip-filter chips on the search screen.
- [x] Country codes — LLM emits ISO-2 `country_code` at extract; Google Places overrides at enrich. Trip Places tab groups by country with section headers when a trip spans multiple countries.
- [x] Six-bucket category taxonomy — food / drinks / stays / sights / activities / shops (collapsed from a placeholder 3-bucket enum). Category icon now visible on every tile, not just the no-photo fallback.
- [x] Per-source "place detected" badge in the source-detail toolbar; tap opens the places-found sheet.
- [x] Per-trip "Places" tab with grid layout, plus a sibling "Sources" sub-tab.
- [x] Maps deep-link with installed-app detection (`comgooglemaps` URL scheme; falls back to Apple Maps).
- [x] **URL share for Instagram and TikTok posts** — share extension accepts post URLs; worker `POST /fetch-post` resolves them via `og:*` meta tags (fast path), Apify (IG carousels and og: failures), or TikTok's `__UNIVERSAL_DATA_FOR_REHYDRATION__` JSON (photo slideshows). Tap a saved URL source to jump back into IG or TikTok.
- [x] Multi-image OCR for IG carousels and TikTok slideshows — slides 2..N downloaded to temp, OCR'd, deleted; only the cover image is persisted. `ocr_text` is the concat of all slides + caption.
- [x] Triage flow — full-screen pager modal that walks new sources one at a time. Multi-place selection per source with default-on / deselect-to-drop, compact-bottom-sheet trip picker, swipe-down-to-dismiss, tap-to-fullscreen hero, tertiary Delete in the CTA tray.
- [x] App redesign — Sea+Teal palette, dark mode, iOS 26 NativeTabs (liquid glass), full-bleed hero details, FilterPills (All / Untriaged / per-trip) on the home grid, places-first feed.
- [x] Empty-state pass — shared `components/EmptyState.tsx` applied to Pocket / Trips / Trip Detail with CTAs into capture.
- [x] Delete cascade — hard-delete throughout; `deleted_at` columns removed; symmetric orphan prune between `places` and `sources` via the `place_sources` junction; trip delete has untriage default + cascade opt-in.
- [x] In-flight progress feedback — `<ProcessingBanner>` on Pocket / Trip Detail, shimmer on pending tiles, `PROCESSING…` skeleton on Triage cards, skeleton hero on Place Detail. No more post-import `Alert.alert`.
- [x] Per-source pipeline event log — `pipeline_events` table written by `modules/pipeline-log` across `url_fetch` / `image_download` / `ocr` / `extract` / `enrich` stages. Settings → Diagnostics → Pipeline log shows the last 200 rows grouped by source.
- [x] Cloudflare Worker tests + DB / extraction / enrichment / search / pipeline-log Jest coverage.

**Notes on the proxy:** endpoints live — `POST /extract`, `POST /enrich`, `GET /photo/:name`, `POST /fetch-post`. From v1.0 onward (already shipped, see "v1.0" below) `/extract`, `/enrich`, and `/fetch-post` require an `X-RC-User-Id` header that the worker validates against RevenueCat REST with a 60s edge cache. Privacy posture: never logs OCR text or LLM bodies; logs only HTTP status, latency, error class, and (dev-only) a small `_debug` echo of route / og outcome / Apify outcome / cache hit.

**Cut from v0.2:**

- Manual tagging UI — formally cut 2026-05-10. AI-set `places.category` covers the launch-promise behaviour and avoids adding a write-surface that exists only to override the AI. Revisit in v1.x only if users actually ask.
- Trip detail filtering by tag/category — moved to v1.x with the rest of the tag-editor surface area. Trip detail's "Map" view remains a "coming soon" placeholder (full map is v1.x).

**Performance pass deferred to v0.3 (TestFlight):** on-device profiling of list scroll fps + cold-launch TTI, photo-proxy size validation against measured display sizes, and triage's unbounded `EXTRACTED_SQL` (currently fetches all `place_sources` and filters in JS). Drive-by fixes already shipped: `recyclingKey` on `PlaceTile` + Trips-list preview thumb; Pocket grid cell extracted to memoised `GridCell` with stable cell-style memo.

---

## v0.3 — "TestFlight beta" — 🟢 in progress

Stop shipping new features. Make it okay to hand to a friend.

**Definition of done:** 5–10 friends are using it on TestFlight. App is crash-free for a week. I have a list of real-user feedback.

**Status (2026-05-15):** the build pipeline, crash reporting, error UX, and the redesigned onboarding are all live. App is on `version 0.3.0` (`buildNumber 7` server-managed by EAS). What remains for the milestone is real beta distribution + the v1.0 paywall items that gate first launch, several of which have already shipped (see v1.0 below).

**Shipped:**

- [x] Onboarding flow — six-screen sequence (Welcome → Destination → Pain Points → Solution → Demo → Paywall). Demo includes tap-to-transform on a multi-place screenshot and an IG share-sheet path. Destination answer personalizes paywall headline. Spec: `docs/superpowers/specs/2026-05-13-onboarding-redesign-design.md`.
- [x] Error handling pass — toast service + permission helper + classifier + share-extension Retry/Cancel inline error UI. Handles share-sheet import failures, denied Photos (with Open Settings deep-link), partial camera-roll failures, and storage-full detection.
- [x] Sentry — JS + native crash/error capture for non-dev builds, anonymous install-UUID identity, pipeline-stage breadcrumbs (category only, no payload), branded `<ErrorBoundary>` fallback. Sourcemaps uploaded by `eas-build-on-success`.
- [x] TestFlight pipeline — `production` EAS build + submit profiles, `appVersionSource: remote`, `whatsnew/en-US.txt`, `docs/RELEASE.md` runbook.
- [x] App icon and launch screen.

**Remaining:**

- [ ] Accessibility pass: VoiceOver, Dynamic Type.
- [ ] Performance pass deferred from v0.2 — on-device list-scroll fps + cold-launch TTI profiling, photo-proxy resize validation, bound the triage `EXTRACTED_SQL` query.
- [ ] Marketing screenshots for App Store Connect.
- [ ] Hand the build to 5–10 friends on TestFlight; collect feedback for a week.

---

## v1.0 — "App Store launch" — 🟢 in progress

Public. Paid from day one.

**Definition of done:** live on the App Store. Paywall is the gate at first launch and on entitlement lapse; trial-active and subscribed users get the whole app; everyone else is bounced back to the paywall with their data preserved in read-only state.

**Status (2026-05-15):** the paywall, entitlement plumbing, and proxy auth landed during the v0.3 prep window — paid-from-day-one mechanics are wired end-to-end. What remains is the App Store listing, privacy policy, in-app feedback, and PostHog telemetry.

**Shipped:**

- [x] Pricing decided — Yearly $39.99 (7-day free trial) + Weekly $3.99 (3-day free trial). Monthly dropped. (Weekly lowered from $4.49 → $3.99 in ASC on 2026-05-16.)
- [x] StoreKit + RevenueCat integration via `react-native-purchases` SDK. Anonymous-only RC identity (`$RCAnonymousID:<uuid>`).
- [x] Paywall renders RC offerings (tiles + trial copy); purchase + restore wired; dev-only dismiss `x`.
- [x] Paywall-after-onboarding gate at first launch; splash holds until entitlement status resolves.
- [x] Lapse handling — when entitlement flips inactive (trial ended without conversion, sub cancelled, billing failed) the app routes to `/paywall-lapse` instead of the onboarding paywall. Local data preserved; resubscribing restores access.
- [x] Cancelled-subscription read-only UX — instead of an aggressive auto-redirect, an inline `<InactiveEntitlementBanner>` is shown; in-flight pipeline rows pause (new `paused_reason` columns, migration `0007`) and resume automatically when entitlement flips back; capture entry points re-check entitlement and re-show the banner. Resume toast on transition. Spec: `docs/superpowers/specs/2026-05-15-cancelled-subscription-ux-design.md`.
- [x] Worker auth — `requireEntitlement` middleware gates `/extract`, `/enrich`, and `/fetch-post`. Client sends `X-RC-User-Id`; worker validates against RevenueCat REST `/v1/subscribers/{id}` with a 60s edge cache. 401 from the proxy pauses the relevant pipeline row rather than failing it.
- [x] Share extension entitlement gate — App Group `UserDefaults` mirror of entitlement status (with 7-day staleness fallback) keeps share-sheet captures honest when the main app hasn't run in a while.
- [x] AI-extraction disclosure surfaced during onboarding (Pain Points / Solution screens).

**Remaining:**

- [ ] Privacy policy + terms of service.
- [ ] App Store listing copy + screenshots.
- [ ] In-app feedback / contact link.
- [ ] PostHog product analytics (`modules/telemetry/`) — spec written (`docs/superpowers/specs/2026-05-12-telemetry-design.md`), implementation deferred. Pipeline-log diagnostics + Sentry cover the v0.3 needs in the interim.
- [ ] Decide whether to A/B-test trial length post-launch (PostHog feature flags, once telemetry lands).

---

## v1.x — Later (post-launch parking lot)

Sequenced post-launch based on what users actually ask for. Order here is a guess, not a commitment.

- Smart suggestions on top of extracted places ("Looks like a café in Tokyo", auto-tagging).
- Manual category override on a place (inline edit on place-detail) + trip-detail filtering by category. Cut from v0.2 on 2026-05-10; revisit only if users ask.
- In-app map view of saved places (uses the lat/lng populated by v0.2 place enrichment).
- Cloud sync across devices (CloudKit while iOS-only; revisit if Android happens).
- Itinerary generation from saved ideas.
- Android.

---

## Decisions deferred

Flagged so they don't get forgotten, but no need to resolve yet:

- ~~LLM provider for the extraction proxy~~ — resolved: Gemini 2.5 Flash Lite via Cloudflare AI Gateway.
- ~~Where the proxy runs~~ — resolved: Cloudflare Workers.
- ~~Pricing tiers~~ — resolved 2026-05-14: Yearly $39.99 (7-day trial) + Weekly $3.99 (3-day trial); monthly dropped. (Weekly lowered from $4.49 → $3.99 on 2026-05-16.)
- ~~Paywall placement (before vs. after onboarding)~~ — resolved: after onboarding. Lapse paywall is a separate root modal at `/paywall-lapse`, not nested under `/onboarding/`.
- Sync direction (CloudKit vs. own backend). Deferred to v1.x.
- API key separation for v1.x place enrichment — single `GOOGLE_API_KEY` shared with Gemini, or dedicated `GOOGLE_PLACES_API_KEY`. Decide at implementation time.

---

## Non-goals (forever, not just early)

Restated from PRODUCT.md so they stay loud:

- A complex itinerary planner.
- Server-side product logic. The AI proxy is a stateless LLM passthrough; product features live on the device.
- Social or sharing features.
- Booking integrations.
- Background screenshot auto-detect. Share-sheet capture is the capture path. PhotoKit observers + background fetch are a meaningful platform lift for an inbox we'd then need an AI classifier to keep clean — and the share sheet already gets capture down to one extra tap. Not a tarpit worth entering.

Each of these is a tarpit. The wedge is _save it before it's lost_.
