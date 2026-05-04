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

### Now
- Expo project set up, dev build running on iPhone, repo bootstrapped.
- Share-sheet target that accepts an image and saves it to app storage.
- Local persistence of saved screenshots (image + minimal metadata).
- Simple list/grid view of saved screenshots.
- One hard-coded "trip" — no trip creation UI yet.

### Next (this milestone)
- Trip creation + manual assign-to-trip.
- "Add from camera roll" flow inside the app.
- Tap-to-view full screenshot.
- Delete a screenshot.

### Later (this milestone)
- Empty state copy.
- Trip rename / delete.
- Basic settings screen (version, about).

### Explicit non-goals for v0.1
- Auto-detect of new screenshots — deferred to v0.2.
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
- Auto-detect new screenshots in background; surface a review queue on app open.
- On-device OCR (Apple Vision via native module if needed).
- Search across OCR text + trip names + tags + extracted place names.
- Manual tagging: place / food / activity.
- Trip detail view with grouping/filtering by tag.
- AI extraction pipeline: thin server-side proxy to an LLM, called from the app per screenshot, results stored locally in `extracted_places`.
- Per-screenshot "place detected" badge; tap → opens Google or Apple Maps.
- Per-trip "Places" tab listing distinct extracted names.
- Performance pass: list scrolling, image loading.

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

Public. Paid.

**Definition of done:** live on the App Store with a working freemium flow, and the AI extraction features clearly gated behind Pro.

**Scope:**
- Free tier: small fixed number of trips, no AI extraction.
- Pro tier: unlimited trips + AI extraction + Places view + tap-to-open in Maps.
- StoreKit + RevenueCat integration.
- Auth on the AI proxy: only forward LLM calls for receipts that RevenueCat confirms as active Pro.
- Paywall screen, triggered when a free user (a) hits the trip cap or (b) attempts an AI-gated action.
- Disclosure that AI features send screenshot text off-device, with an explicit opt-in the first time a user triggers extraction as Pro.
- Privacy policy, terms, App Store listing copy + screenshots.
- Lightweight, privacy-respecting analytics (PostHog).
- In-app feedback / contact link.

**Open questions for launch:**
- Free trip cap. Decide based on what beta users settle into.
- Pricing tiers (monthly + yearly).
- Whether free users get N trial AI extractions per month as a taste, or zero. Default zero unless beta data argues otherwise.

---

## v1.x — Later (post-launch parking lot)

Sequenced post-launch based on what users actually ask for. Order here is a guess, not a commitment.

- Smart suggestions on top of extracted places ("Looks like a café in Tokyo", auto-tagging).
- In-app map view of saved places (geocoding extracted names; complement to the v1.0 maps deep-link).
- Cloud sync across devices (CloudKit while iOS-only; revisit if Android happens).
- Itinerary generation from saved ideas.
- Android.

---

## Decisions deferred

Flagged so they don't get forgotten, but no need to resolve yet:

- LLM provider for the extraction proxy (Anthropic vs. OpenAI vs. small open-weights via a hosted runner). Pick at v0.2 based on accuracy on real screenshots.
- Where the proxy runs (Cloudflare Workers vs. Vercel Functions). Either is fine; pick whichever is faster to ship.
- Free-tier "taste of AI" allowance (N free extractions/month vs. zero). Decide from beta data.
- Sync direction (CloudKit vs. own backend). Deferred to v1.x.

---

## Non-goals (forever, not just early)

Restated from PRODUCT.md so they stay loud:

- A complex itinerary planner.
- Server-side product logic. The AI proxy is a stateless LLM passthrough; product features live on the device.
- Social or sharing features.
- Booking integrations.

Each of these is a tarpit. The wedge is *save it before it's lost*.
