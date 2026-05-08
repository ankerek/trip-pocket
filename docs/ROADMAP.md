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

## v0.1 — "I can use it daily"

The minimum capture/browse loop. Ugly is fine. Goal: prove that saving and re-finding a screenshot inside this app feels meaningfully better than the camera roll. If it doesn't, fix that before adding more.

**Definition of done:** I'm using it on my own phone every day for a week without going back to Photos for the same task.

**Status (2026-05-07):** code-complete except for empty-state polish. The whole capture loop — share-sheet (with trip picker), camera-roll import, list/grid, detail, trip CRUD, delete — works on device. Day-of-use validation is the remaining gate.

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
- [ ] Empty state copy. (Some surfaces have it; needs an audit pass.)
- [x] Trip rename / delete.
- [x] Basic settings screen (version, about). (Version shown; "about" copy minimal.)

### Explicit non-goals for v0.1
- Auto-detect of new screenshots — deferred to v1.x.
- OCR — v0.2.
- Tags — v0.2.
- AI extraction / Places view — v0.2.
- Onboarding — v0.3.
- Any design polish.

---

## v0.2 — "Full MVP, feature-complete"

Everything PRODUCT.md calls "at launch". The app is feature-complete for the wedge — *save it before it's lost* — plus the AI extraction layer that turns screenshots into usable places. Not yet polished for strangers.

**Definition of done:** every "at launch" bullet from PRODUCT.md works end-to-end, capture-to-saved-in-trip is under ~5 seconds, and AI extraction reliably produces a tappable place for the obvious cases (single restaurant or POI in a screenshot).

**Scope:**
- On-device OCR (Apple Vision via native module if needed).
- AI extraction pipeline: thin server-side proxy to an LLM, called from the app per screenshot, results stored locally in `extracted_places`. The same call doubles as a "is this travel?" classifier — an empty result means the screenshot is noise, not content.
- Place enrichment via Google Places API: on-demand fetch of a real photo, 1–2 sentence narrative, rating, hours, price level, and lat/lng the first time a user opens an extracted place. Google Places for facts + Gemini for the narrative, both routed through the existing extract proxy. Free for everyone — this is the magic-moment value prop, not a premium gate. Also replaces the OCR-address search-URL deep link with proper pinned coords. Full design in `docs/superpowers/specs/2026-05-08-place-enrichment-design.md`.
- Search across OCR text + trip names + tags + extracted place names.
- Manual tagging: place / food / activity.
- Trip detail view with grouping/filtering by tag.
- Per-screenshot "place detected" badge; tap → opens Google or Apple Maps.
- Per-trip "Places" tab listing distinct extracted names.
- Performance pass: list scrolling, image loading.

**Sequencing inside v0.2:** OCR ships first (also unlocks search). Then AI extraction (also unlocks the Places tab and per-screenshot badge). Then place enrichment, which depends on extraction landing first. The remaining items — manual tagging, trip-detail filtering, performance pass — are independent and slot in alongside whenever convenient.

**Note on the proxy:** the proxy ships from v0.2 onward — it's free for me to run while there are no users, and TestFlight users in v0.3 should hit it without any auth (auth is added at v1.0 alongside the paywall).

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

- **Auto-detect new screenshots in background**, **gated by the AI classifier**: only screenshots that yield ≥1 extracted place surface in Inbox; the rest are recorded for dedup but stay hidden. Raw auto-detect (every screenshot into Inbox) was rejected — without the classifier, Inbox becomes a junk drawer, not an inbox. Deferred from v0.2: PhotoKit observers + background fetch are a meaningful platform lift, and share-sheet capture already covers the daily-use loop.
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

Each of these is a tarpit. The wedge is *save it before it's lost*.
