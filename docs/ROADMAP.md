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
- Onboarding — v0.3.
- Any design polish.

---

## v0.2 — "Full MVP, feature-complete"

Everything PRODUCT.md calls MVP. The app is feature-complete for the wedge — *save it before it's lost* — but not yet polished for strangers.

**Definition of done:** every MVP bullet from PRODUCT.md works end-to-end, and capture-to-saved-in-trip is under ~5 seconds.

**Scope:**
- Auto-detect new screenshots in background; surface a review queue on app open.
- On-device OCR (Apple Vision via native module if needed).
- Search across OCR text + trip names + tags.
- Manual tagging: place / food / activity.
- Trip detail view with grouping/filtering by tag.
- Performance pass: list scrolling, image loading.

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

**Definition of done:** live on the App Store with a working freemium flow.

**Scope:**
- Free tier: small fixed number of trips.
- Premium tier: unlimited trips. (AI and sync are explicitly *not* gating launch — they live in v1.x.)
- StoreKit / RevenueCat integration.
- Privacy policy, terms, App Store listing copy + screenshots.
- Lightweight, privacy-respecting analytics (PostHog or simple event log).
- In-app feedback / contact link.

**Open question for launch:** what's the free trip cap? Decide based on what beta users settle into.

---

## v1.x — Later (post-launch parking lot)

Sequenced post-launch based on what users actually ask for. Order here is a guess, not a commitment.

- AI place / city extraction from screenshots (cloud, premium-gated).
- Map view of saved places.
- Smart suggestions ("Looks like a café in Tokyo").
- Export to Google Maps.
- Cloud sync across devices (iCloud or own backend).
- Itinerary generation from saved ideas.
- Android.

---

## Decisions deferred

Flagged so they don't get forgotten, but no need to resolve yet:

- Backend or pure local-first? — pure local through v1.0; revisit when sync is on the table.
- OCR engine: Apple Vision via a small native module vs. an Expo-friendly wrapper.
- Storage: SQLite / WatermelonDB vs. plain files + a JSON index.
- Subscription plumbing: StoreKit direct vs. RevenueCat.
- Analytics provider.

---

## Non-goals (forever, not just early)

Restated from PRODUCT.md so they stay loud:

- A complex itinerary planner.
- Server-dependent heavy AI as a core flow.
- Social or sharing features.
- Booking integrations.

Each of these is a tarpit. The wedge is *save it before it's lost*.
