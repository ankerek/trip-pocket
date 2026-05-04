# Trip Pocket — Architecture

Solo working document. Companion to PRODUCT.md (what) and ROADMAP.md (when). This is the *how*, scoped through v1.0 with light forward-notes for v1.x.

## Scope

In scope:

- The shape of the iOS app from v0.1 capture loop through v1.0 App Store launch.
- Load-bearing technical decisions: storage, reactivity, native modules, freemium, telemetry.
- Cheap forward-proofing for v1.x sync (and the no-op for sharing).

Out of scope:

- Step-by-step implementation plans — those live separately.
- Visual design / UX flows beyond what shapes architecture.
- Anything past v1.0 except as a "leave the door open" note.

## Stack at a glance

- **App runtime:** React Native via Expo prebuild + config plugins. EAS for dev / preview / production builds. Bare workflow not used.
- **Languages:** TypeScript across the JS side; Swift for the three native iOS modules.
- **Storage:** SQLite (`expo-sqlite`) with FTS5 for search; image bytes as files in the app sandbox.
- **Reactivity:** SQLite update-hook live queries via a small `useLiveQuery` hook; no Redux / Zustand / React Query.
- **Navigation:** Expo Router (file-based, typed routes).
- **Styling:** NativeWind v4 with a single token file (colors, spacing, type scale).
- **Monetization:** RevenueCat wrapping StoreKit (v1.0+).
- **Crash + analytics:** Sentry for crashes, PostHog for product events. Marketing-site analytics (Umami / Plausible) is a separate concern when the site exists.
- **Backend:** a thin AI extraction proxy (Cloudflare Worker or Vercel Function) ships with the app from v0.2 onward. No app-data backend in v1.0; the device is still the source of truth for everything except the AI call itself.
- **Platforms:** iOS only through v1.0. Android lives in the v1.x parking lot.

## Data model

All primary keys are UUIDs (generated client-side). Every syncable table carries `updated_at`, `deleted_at` (soft delete), and `owner_id`. `owner_id` is a UUID stamped at first launch — there's one owner ever in v1.0, but the column is the cheap concession to a hypothetical sharing future.

Tables:

- `trips` — `id`, `name`, `color`, `created_at`, `updated_at`, `deleted_at`, `owner_id`.
- `screenshots` — `id`, `trip_id` (nullable; `NULL` = Inbox), `file_path`, `content_hash`, `source` (`share` | `auto` | `manual`), `ocr_status` (`pending` | `done` | `failed`), `ocr_text`, `extraction_status` (`pending` | `done` | `failed` | `skipped`), `captured_at`, `created_at`, `updated_at`, `deleted_at`, `owner_id`. `extraction_status: skipped` covers free-tier screenshots that were never sent to the proxy.
- `tags` — `id`, `screenshot_id`, `kind` (`place` | `food` | `activity`), `value`, `created_at`, `updated_at`, `deleted_at`, `owner_id`.
- `extracted_places` — `id`, `screenshot_id`, `name`, `city`, `category` (nullable), `raw_text` (the OCR snippet the LLM used), `confidence`, `extraction_model`, `created_at`, `updated_at`, `deleted_at`, `owner_id`. One screenshot can produce zero, one, or many rows.
- `pending_imports` — `id`, `app_group_path`, `suggested_trip_id`, `created_at`. Written by the share extension, consumed by the main app on next foreground. Not synced.
- `meta` — single-row settings table for things like `last_seen_screenshot_at`.
- `screenshots_fts` — FTS5 virtual table indexing `screenshots.ocr_text` plus the screenshot's tag values, extracted place names, and parent trip name as a single searchable document per screenshot. Kept in sync via SQLite triggers.

## Module structure

App code (TypeScript / React):

- `app/` — screens, navigation, components. UI layer only, no business logic.
- `modules/storage/` — SQLite schema, migrations, repositories. The *only* place that touches SQL.
- `modules/capture/` — share-extension hand-off, manual import, auto-detect observer client.
- `modules/processing/` — OCR pipeline, content hashing, dedup, indexing.
- `modules/extraction/` — AI extraction client: takes OCR text, calls the proxy, persists `extracted_places` rows. The only module that talks to the proxy.
- `modules/search/` — FTS query helpers.
- `modules/trips/` — trip and tag domain logic.
- `modules/places/` — extracted-places UI logic (per-screenshot badges, per-trip Places tab) and maps deep-link helpers (`openInMaps(name, city?)`).
- `modules/monetize/` — paywall, entitlements (v1.0). Also the only module that reads RevenueCat receipts; the extraction module asks `monetize.isPro()` before dispatching a proxy call.
- `modules/telemetry/` — PostHog event vocabulary, Sentry wrapper.

Native iOS code (Swift, via Expo Modules):

- `native/ShareExtension/` — Share Extension target with custom Swift UI.
- `native/ScreenshotObserver/` — PhotoKit-based scan-since-last-seen.
- `native/VisionOCR/` — Apple Vision text recognition wrapper.

Boundaries:

- `storage` is the only module that knows SQL exists. Everyone else asks `storage` for typed objects.
- `capture`, `processing`, `extraction`, `search` are *workflow* modules — they orchestrate but don't own data.
- `places`, `trips`, `monetize`, `telemetry` are *capability* modules — they expose typed APIs for the UI to call.
- `app/` has zero business logic. Screens call modules and render.
- No "service" or "repository" layer above `storage`. Storage *is* the repository. One layer of abstraction, not two.
- No global `models/` or `types/` folder. Types live with the module that owns them.

## Key flows

### Ingestion: share extension

1. User taps Share on a screenshot in Photos. "Trip Pocket" appears.
2. Native share extension UI (SwiftUI) reads the trip list from shared SQLite (App Group container).
3. User picks a trip (last-used pre-selected) or "Inbox".
4. Extension copies the image into the App Group container and writes a `pending_imports` row carrying the chosen `trip_id`.
5. Extension dismisses; user is back in Photos. Total time should feel like one extra tap.
6. On the main app's next foreground, `modules/capture`:
    - Reads `pending_imports`.
    - Moves the image to the main app sandbox.
    - Computes a content hash, dedupes against `screenshots`.
    - Writes a `screenshots` row with `ocr_status: pending`, the chosen `trip_id` (or `NULL`), `source: share`.
    - Deletes the `pending_imports` row.

The share extension is a *dumb mailbox*. It never runs OCR or anything memory-heavy — iOS extensions have ~120 MB and a few seconds of runtime, both easy to blow past.

### Ingestion: auto-detect

- On every foreground, `ScreenshotObserver` (native) returns all camera-roll items added since `meta.last_seen_screenshot_at` and matching iOS's `.photoScreenshot` filter.
- New screenshots flow through the same hash → dedup → insert path as share, with `trip_id = NULL` (always Inbox) and `source = auto`.
- Requires Photos: limited or full library access. Permission is requested in onboarding (v0.3) with a soft pre-prompt.

### Ingestion: manual import

- "Add from camera roll" inside the app uses `expo-image-picker`.
- After picking, the same trip-picker component as the share extension is shown (with "Inbox" as default).
- Same hash → dedup → insert path. `source = manual`.

### Processing

- `modules/processing` is invoked on app foreground if rows with `ocr_status: pending` exist.
- Processes one screenshot at a time, calling into `VisionOCR` (which runs on a background dispatch queue, off the JS thread).
- On success: writes `ocr_text`, flips `ocr_status: done`. FTS updates via triggers.
- On failure: `ocr_status: failed`, retried on next foreground up to N attempts (N TBD; start at 3).
- No iOS `BGTaskScheduler` in v1.0. If beta users complain about long backlogs not processing in the background, revisit.

### Extraction (AI)

- After a screenshot's `ocr_status` flips to `done`, `modules/extraction` is eligible to process it.
- `modules/extraction` checks `monetize.isPro()` (v1.0+; before v1.0 the gate is open and TestFlight users get extraction free).
- If allowed: posts the OCR text + image hash + a tiny content-type hint to the proxy.
- The proxy forwards to the LLM with a fixed prompt asking for `[{name, city, category, confidence}]` as JSON. Only the LLM call goes off-device — the image bytes don't.
- On response: writes one `extracted_places` row per result, joined to the screenshot. FTS picks them up via triggers.
- Failure modes (network down, proxy 5xx, LLM bad JSON): noted on the screenshot row as `extraction_status: failed`, retried on next foreground up to N attempts. Silent in UI — extraction is best-effort.
- Same single-at-a-time discipline as OCR. No background extraction in v1.0.

### Browse / search

- **Inbox:** `screenshots` with `trip_id IS NULL` and `deleted_at IS NULL`, ordered by `captured_at desc`.
- **Trip detail:** two tabs.
    - **Screenshots:** the existing image grid for that trip.
    - **Places:** distinct rows from `extracted_places` joined through that trip's screenshots, deduped by case-insensitive `(name, city)`. Each row has a "Open in Maps" affordance — `places.openInMaps(name, city)` builds either `comgooglemaps://` (if installed) or `https://www.google.com/maps/search/?api=1&query=…` and hands off via `Linking.openURL`. Tapping the row anywhere else navigates to the source screenshot.
- **Search:** FTS5 query against `screenshots_fts`, joined back to `screenshots`. Extracted place names are part of the indexed document, so searching "tonkatsu" finds screenshots whose extracted place is "Maru Tonkatsu" even if "tonkatsu" never appeared verbatim in the OCR text.
- All list views use `useLiveQuery`, so they re-render automatically as ingestion / OCR / extraction / tagging completes.

## Native iOS modules

Three Expo Modules, each ~100–300 lines of Swift. We own them. Community packages in this niche tend to go unmaintained, and we need precise control (e.g., the share extension reads our SQLite directly).

### ShareExtension

- iOS Share Extension target with custom SwiftUI.
- Trip picker + Save button.
- Reads the trip list from shared SQLite at `group.com.trippocket.shared`.
- Streams the image to disk; never holds a full `UIImage` in memory.
- Writes the `pending_imports` row.

### ScreenshotObserver

- Wraps `PHPhotoLibrary.fetchAssets` filtered to `mediaSubtypes.contains(.photoScreenshot)`.
- Exposes `getNewScreenshotsSince(timestamp) → [{ assetId, capturedAt, imagePath }]` to JS.
- Materializes assets to a temp directory the JS side reads.

### VisionOCR

- Wraps `VNRecognizeTextRequest`.
- Exposes `recognizeText(imagePath, locale?) → string` to JS.
- Runs on a background `DispatchQueue` to keep the main thread clear.
- Returns concatenated text only — no bounding boxes; we don't need them yet.

## Reactivity

- `expo-sqlite` exposes change notifications via SQLite's update hook.
- A small `useLiveQuery(sql, params, tables)` hook subscribes the component to the listed tables and re-runs the query on changes. ~50–100 lines.
- **Fallback** (if the live-update API proves flaky in practice): a tiny in-process event bus invoked by our writes. Same hook surface, manual signal instead of automatic.
- No Redux, Zustand, or React Query. The DB is the source of truth; the UI reads from it.
- This shape is also sync-friendly: a future sync writer hits SQLite the same way local writes do, and the UI reacts identically.

## Permissions

- **Photos:** read access ("Selected" or "Full Library"). Required for auto-detect and manual import. Requested in onboarding with a soft pre-prompt explaining the value.
- **Notifications (v0.3+):** optional, used for "you have N new screenshots to triage" reminders.
- No location, no contacts, no microphone, no camera.

## Cross-cutting

### Migrations

- SQL migrations as numbered files in `modules/storage/migrations/`. Linear, no down-migrations.
- A migration runner applies anything new on launch and stores the current version in `meta`.

### Freemium (v1.0)

- **RevenueCat** wraps StoreKit. Receipt validation server-side (RevenueCat's), entitlements + dashboard, no babysitting StoreKit edge cases (refunds, family sharing, sub-state changes).
- Products: `pocket_pro_monthly` and `pocket_pro_yearly` (final pricing decided at v1.0 launch).
- `monetize.isPro()` is synchronous from cached state, refreshed on foreground.
- **Free tier:** screenshot capture, storage, OCR-search, manual tagging, small trip-count cap. No AI extraction.
- **Pro tier:** unlimited trips, AI extraction, the per-trip Places tab, tap-to-open in Maps.
- Paywall is a single screen, triggered when a free user (a) hits the trip cap or (b) attempts a Pro-gated action like opening Places.
- The AI proxy independently validates the user's RevenueCat receipt before forwarding to the LLM — the client-side `monetize.isPro()` check is a UX hint, not a security boundary.
- The `monetize` module is the only place RevenueCat is imported. Swapping later (or going StoreKit-direct) is local to the module.

### Telemetry

- **PostHog** for product analytics, wrapped by `modules/telemetry`. Events are defined as a typed vocabulary in one file — no ad-hoc `track("button_clicked")` calls strewn around.
- **Sentry** for crash + non-fatal error reporting. Initialized in app entry. `telemetry.captureError(err, ctx?)` is the handled-error helper.
- **Privacy:** telemetry never sees content — image bytes, OCR text, and trip names do not flow to PostHog or Sentry. Telemetry is structural (which screens, which features, which conversions) only.
- **Privacy (AI):** AI extraction explicitly *does* send OCR text off-device to the proxy and onward to the LLM. Image bytes still don't leave. This is disclosed in onboarding and in the privacy policy, and the first time a Pro user triggers extraction we surface an explicit opt-in modal.

### Error handling

- Ingestion failures (file copy, dedup conflict): one-line toast, retry. The `pending_imports` row stays until success.
- OCR failures: silent in UI. The screenshot is still browsable, just not searchable. Reported to Sentry with breadcrumbs.
- Storage full: hard banner, blocks new imports until resolved.
- All non-trivial error paths flow through `telemetry.captureError`.

### Testing

- Unit tests for pure-logic modules: `processing`, `extraction` (mocking the proxy), `search`, `storage` repositories. Jest.
- Native modules: smoke-tested manually on device. Not unit-tested; cost / value is wrong for solo dev at this stage.
- E2E: deferred. Maestro is on the table for v0.3+ if it pays back.

### AI extraction proxy

The proxy is the only piece of server-side infrastructure in v1.0. Keep it boring.

- **Runtime:** Cloudflare Workers (or Vercel Functions; pick whichever is faster to ship). Stateless, no database.
- **Endpoint:** `POST /extract` taking `{ ocr_text, content_type_hint?, request_id }`. Returns `[{name, city, category, confidence}]`.
- **LLM call:** a single fixed prompt to Anthropic's API (or equivalent). Prompt and model name versioned; clients send the model version they expect, and the worker pins to it.
- **Auth:** before v1.0, no auth — TestFlight users hit it freely. At v1.0, the worker validates a RevenueCat-issued subscriber identifier (or RevenueCat's webhook-fed cache) before forwarding. Free users get a 403.
- **Rate limiting:** per-user (by subscriber id) and global, to bound cost in the worst case.
- **Logging:** request id, latency, token counts. No OCR text in logs by default.
- **Privacy:** the proxy never persists OCR text. It forwards to the LLM and returns the parsed result.
- **Cost ceiling:** at expected volume the LLM cost is small change; the worker exists primarily to keep the API key off-device and to enforce the Pro gate.

The `extraction` module on the device is the only client. If we ever need a second client (e.g., a backfill script), it talks to the same endpoint with a separate auth path.

## Forward look (v1.x and beyond)

These are not in v1.0. They influence today only via the cheap future-proofing rules (UUID PKs, `updated_at`, `deleted_at`, `owner_id`).

### Sync

- Default direction while iOS-only: **CloudKit** (`CKRecord`). Free, no servers, tied to Apple ID.
- Implementation: a `sync` module that maps SQLite rows to CKRecords keyed by our UUIDs, uses `updated_at` for last-write-wins, respects `deleted_at`.
- Sync writes hit SQLite the same way local writes do. The reactive UI doesn't care about origin.
- If/when Android forces a cross-platform sync answer: evaluate **PowerSync** or **ElectricSQL** (both speak SQLite natively) before hand-rolling a backend.

### AI beyond v1.0

The v1.0 AI feature is place extraction (covered above under Cross-cutting). v1.x layers add:

- **Smart suggestions** ("looks like a café in Tokyo", auto-tagging) on top of extracted places. Same proxy, richer prompts.
- **In-app map view** rendering extracted places by lat/lng. Requires geocoding (Apple `MKLocalSearch`); complement to the v1.0 maps deep-link, not a replacement.
- **Itinerary generation** from extracted places. Larger LLM payloads; same auth model.

All of these reuse the existing proxy and the existing `extracted_places` table, possibly with extra columns (`lat`, `lng`, `geocoded_at`).

### Sharing (currently a forever non-goal)

- Not designed for. The `owner_id` column is the only concession.
- If ever revisited, requires accounts, real backend, and a permissions model — a different shape of app.

### Android

- Not in v1.0 scope. Adding it forces:
    - Replace `VisionOCR` with ML Kit Text Recognition.
    - Replace `ScreenshotObserver` with a `MediaStore` / `ContentObserver` equivalent.
    - Replace `ShareExtension` with an Android intent filter activity.
    - CloudKit can't go cross-platform; sync would need PowerSync, Electric, or own backend.
- The TypeScript app code (including `extraction`, `places`, the proxy client) is platform-agnostic, so the rebuild is concentrated in `native/` and the sync layer.

## Open questions

- Free tier trip cap (decide post-beta).
- Subscription pricing tiers (decide at v1.0 launch).
- Free-tier "taste of AI" allowance — N free extractions per month vs zero. Default zero unless beta data argues otherwise.
- LLM provider for the extraction proxy (Anthropic vs OpenAI vs hosted open-weights). Pick at v0.2 by accuracy on real screenshots.
- Proxy runtime (Cloudflare Workers vs Vercel Functions). Either is fine; pick whichever is faster to ship.
- Image storage location: `Documents/` (iCloud-backed-up) vs `Library/Application Support/`. Default to `Application Support/screenshots/` unless we explicitly want OS-managed iCloud Drive backup.
- OCR locale: device default vs auto-detection. Start with device locale; revisit if multilingual screenshots are common in beta.
- Number of OCR retry attempts before marking `failed` (start at 3). Same default for extraction retries.

## Non-goals

Restated from PRODUCT.md so they remain loud:

- Itinerary planner. (Place extraction is *not* the same thing as itinerary building.)
- Server-side product logic. The proxy is a stateless LLM passthrough; product features live on the device.
- Social or sharing features.
- Booking integrations.
