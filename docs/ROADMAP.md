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
- Tags — v0.2.
- AI extraction / Places view — v0.2.
- Onboarding — v0.3.
- Any design polish.

---

## v0.2 — "Full MVP, feature-complete" — 🟢 in progress

Everything PRODUCT.md calls "at launch". The app is feature-complete for the wedge — *save it before it's lost* — plus the AI extraction layer that turns screenshots into usable places. Not yet polished for strangers.

**Definition of done:** every "at launch" bullet from PRODUCT.md works end-to-end, capture-to-saved-in-trip is under ~5 seconds, and AI extraction reliably produces a tappable place for the obvious cases (single restaurant or POI in a screenshot).

**Status (2026-05-09):** core pipeline is shipped end-to-end on device. OCR, AI extraction, enrichment, photo proxy, search, places-first home, triage, per-trip Places tab, per-source places-found sheet, Maps deep-link — all live. Two design changes vs. the original plan:
- Schema collapsed to a places-first shape (`places` + `place_sources` junction + generalised `sources`) before any users existed; FTS5 indexes the place document, not the source document.
- `places.category` is populated by the AI extractor rather than asked of the user, so the "manual tagging" deliverable is partial — the categorisation works, but there's no tag editor in the UI yet.

**Shipped:**
- [x] On-device OCR via Apple Vision (`modules/vision-ocr/`, Swift Expo Module).
- [x] AI extraction pipeline: Cloudflare Worker proxy fronting Gemini 2.5 Flash-Lite via Cloudflare AI Gateway. Empty result = noise classifier.
- [x] Place enrichment: Google Places + Gemini narrative through the same proxy (`/enrich`), plus a `/photo/:name` image proxy for resized venue photos. Lat/lng populates Maps deep-links.
- [x] FTS5 search across place name, city, description, `place_sources.raw_text` (capped 2 KB per source), and `extracted_address`. Trip-filter chips on the search screen.
- [x] Per-source "place detected" badge in the source-detail toolbar; tap opens the places-found sheet.
- [x] Per-trip "Places" tab with grid layout, plus a sibling "Sources" sub-tab.
- [x] Maps deep-link with installed-app detection (`comgooglemaps` URL scheme; falls back to Apple Maps).
- [x] Cloudflare Worker tests + DB / extraction / enrichment / search Jest coverage.
- [x] **Beyond original scope:** app redesign — Sea+Teal palette, dark mode, iOS 26 NativeTabs (liquid glass), full-bleed hero details, FilterPills (All / Untriaged / per-trip) on the home grid, places-first feed.
- [x] **Beyond original scope:** triage flow — full-screen pager modal that walks new sources one at a time, picking-a-trip auto-saves and advances. (Triage redesign approved 2026-05-09 — see "In flight" below.)

**In flight:**
- [ ] Triage redesign — multi-place selection per source, default-on with deselect-to-drop, swipe-down-to-dismiss. Spec: `docs/superpowers/specs/2026-05-09-triage-redesign-design.md`.
- [ ] Empty-state audit across the app (carried over from v0.1).
- [ ] Performance pass on list scrolling and image loading. Photo proxy is in place, virtualization is wired, but no formal measurement pass yet.

**Open / cut:**
- Manual tagging UI: AI-set categories cover the launch-promise behaviour. Decision pending — ship a tag editor, or formally cut and lean on AI categories for v1.0.
- Trip detail filtering by tag/category: deferred until the manual-tagging decision lands. Trip detail's "Map" view is currently a "coming soon" placeholder (full map is v1.x).

**Note on the proxy:** the proxy ships from v0.2 onward — it's free for me to run while there are no users, and TestFlight users in v0.3 should hit it without any auth (auth is added at v1.0 alongside the paywall). Endpoints live: `POST /extract`, `POST /enrich`, `GET /photo/:name`. Privacy posture: never logs OCR text or LLM bodies; logs only HTTP status, latency, and error class.

---

## v0.3 — "TestFlight beta"

Stop shipping new features. Make it okay to hand to a friend.

**Definition of done:** 5–10 friends are using it on TestFlight. App is crash-free for a week. I have a list of real-user feedback.

**Scope:**
- Onboarding flow (3 screens max).
- Empty states everywhere.
- Error handling: failed import, storage full, denied photo permissions.
- Accessibility pass: VoiceOver, Dynamic Type.
- Crash reporting (Sentry or equivalent).
- App icon, launch screen, marketing screenshots.
- TestFlight pipeline.

---

## v1.0 — "App Store launch"

Public. Paid from day one.

**Definition of done:** live on the App Store. Paywall is the gate at first launch and on entitlement lapse; trial-active and subscribed users get the whole app; everyone else is locked out.

**Scope:**
- Single paid tier: monthly + yearly subscription, both with a 7-day free trial.
- StoreKit + RevenueCat integration with the introductory offer (the trial) configured in App Store Connect.
- Paywall screen at first launch (after onboarding); cannot be dismissed without starting the trial or already being subscribed.
- Trial-expiry / cancellation lock: when entitlement lapses, the app falls back to the paywall on next foreground. Local data preserved; resubscribing restores access.
- Auth on the AI proxy: only forward LLM calls for users RevenueCat confirms as trial-active or subscribed.
- Disclosure that AI features send screenshot text off-device, surfaced during onboarding.
- Privacy policy, terms, App Store listing copy + screenshots.
- Lightweight, privacy-respecting analytics (PostHog).
- In-app feedback / contact link.

**Open questions for launch:**
- Pricing tiers (monthly + yearly amounts).
- Whether the paywall sits before or after onboarding. Default: paywall *after* onboarding so the user has seen what they're paying for; revisit if beta data argues otherwise.
- Whether to A/B-test the trial length around 7 days post-launch (PostHog feature flags).

---

## v1.x — Later (post-launch parking lot)

Sequenced post-launch based on what users actually ask for. Order here is a guess, not a commitment.

- Smart suggestions on top of extracted places ("Looks like a café in Tokyo", auto-tagging).
- In-app map view of saved places (uses the lat/lng populated by v0.2 place enrichment).
- Cloud sync across devices (CloudKit while iOS-only; revisit if Android happens).
- Itinerary generation from saved ideas.
- Android.

---

## Decisions deferred

Flagged so they don't get forgotten, but no need to resolve yet:

- ~~LLM provider for the extraction proxy~~ — resolved: Gemini 2.5 Flash Lite via Cloudflare AI Gateway (v0.2 ships with this).
- ~~Where the proxy runs~~ — resolved: Cloudflare Workers (v0.2 ships with this).
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

Each of these is a tarpit. The wedge is *save it before it's lost*.
