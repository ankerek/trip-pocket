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
- **Backend:** none for v1.0. Forward-looking notes below.
- **Platforms:** iOS only through v1.0. Android lives in the v1.x parking lot.

## Data model

All primary keys are UUIDs (generated client-side). Every syncable table carries `updated_at`, `deleted_at` (soft delete), and `owner_id`. `owner_id` is a UUID stamped at first launch — there's one owner ever in v1.0, but the column is the cheap concession to a hypothetical sharing future.

Tables:

- `trips` — `id`, `name`, `color`, `created_at`, `updated_at`, `deleted_at`, `owner_id`.
- `screenshots` — `id`, `trip_id` (nullable; `NULL` = Inbox), `file_path`, `content_hash`, `source` (`share` | `auto` | `manual`), `ocr_status` (`pending` | `done` | `failed`), `ocr_text`, `captured_at`, `created_at`, `updated_at`, `deleted_at`, `owner_id`.
- `tags` — `id`, `screenshot_id`, `kind` (`place` | `food` | `activity`), `value`, `created_at`, `updated_at`, `deleted_at`, `owner_id`.
- `pending_imports` — `id`, `app_group_path`, `suggested_trip_id`, `created_at`. Written by the share extension, consumed by the main app on next foreground. Not synced.
- `meta` — single-row settings table for things like `last_seen_screenshot_at`.
- `screenshots_fts` — FTS5 virtual table indexing `screenshots.ocr_text` plus the screenshot's tag values and parent trip name as a single searchable document per screenshot. Kept in sync via SQLite triggers.

## Module structure

App code (TypeScript / React):

- `app/` — screens, navigation, components. UI layer only, no business logic.
- `modules/storage/` — SQLite schema, migrations, repositories. The *only* place that touches SQL.
- `modules/capture/` — share-extension hand-off, manual import, auto-detect observer client.
- `modules/processing/` — OCR pipeline, content hashing, dedup, indexing.
- `modules/search/` — FTS query helpers.
- `modules/trips/` — trip and tag domain logic.
- `modules/monetize/` — paywall, entitlements (v1.0).
- `modules/telemetry/` — PostHog event vocabulary, Sentry wrapper.

Native iOS code (Swift, via Expo Modules):

- `native/ShareExtension/` — Share Extension target with custom Swift UI.
- `native/ScreenshotObserver/` — PhotoKit-based scan-since-last-seen.
- `native/VisionOCR/` — Apple Vision text recognition wrapper.

Boundaries:

- `storage` is the only module that knows SQL exists. Everyone else asks `storage` for typed objects.
- `capture`, `processing`, `search` are *workflow* modules — they orchestrate but don't own data.
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

### Browse / search

- **Inbox:** `screenshots` with `trip_id IS NULL` and `deleted_at IS NULL`, ordered by `captured_at desc`.
- **Trip detail:** `screenshots` for that trip, optionally filtered by tag `kind`.
- **Search:** FTS5 query against `screenshots_fts`, joined back to `screenshots`.
- All list views use `useLiveQuery`, so they re-render automatically as ingestion / OCR / tagging completes.

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
- Free tier limit: trip-count cap (number TBD from beta data).
- Paywall is a single screen, triggered when the user tries to create a trip past the cap.
- The `monetize` module is the only place RevenueCat is imported. Swapping later (or going StoreKit-direct) is local to the module.

### Telemetry

- **PostHog** for product analytics, wrapped by `modules/telemetry`. Events are defined as a typed vocabulary in one file — no ad-hoc `track("button_clicked")` calls strewn around.
- **Sentry** for crash + non-fatal error reporting. Initialized in app entry. `telemetry.captureError(err, ctx?)` is the handled-error helper.
- **Privacy:** image bytes, OCR text, and trip names never leave the device. Telemetry is structural (which screens, which features, which conversions), never content.

### Error handling

- Ingestion failures (file copy, dedup conflict): one-line toast, retry. The `pending_imports` row stays until success.
- OCR failures: silent in UI. The screenshot is still browsable, just not searchable. Reported to Sentry with breadcrumbs.
- Storage full: hard banner, blocks new imports until resolved.
- All non-trivial error paths flow through `telemetry.captureError`.

### Testing

- Unit tests for pure-logic modules: `processing`, `search`, `storage` repositories. Jest.
- Native modules: smoke-tested manually on device. Not unit-tested; cost / value is wrong for solo dev at this stage.
- E2E: deferred. Maestro is on the table for v0.3+ if it pays back.

## Forward look (v1.x and beyond)

These are not in v1.0. They influence today only via the cheap future-proofing rules (UUID PKs, `updated_at`, `deleted_at`, `owner_id`).

### Sync

- Default direction while iOS-only: **CloudKit** (`CKRecord`). Free, no servers, tied to Apple ID.
- Implementation: a `sync` module that maps SQLite rows to CKRecords keyed by our UUIDs, uses `updated_at` for last-write-wins, respects `deleted_at`.
- Sync writes hit SQLite the same way local writes do. The reactive UI doesn't care about origin.
- If/when Android forces a cross-platform sync answer: evaluate **PowerSync** or **ElectricSQL** (both speak SQLite natively) before hand-rolling a backend.

### AI (premium-gated)

- A thin **Cloudflare Worker** (or Vercel Function) as a stateless proxy to Anthropic's API.
- Auth via RevenueCat receipt validation: the worker only forwards LLM calls for active subscribers.
- The app remains fully usable without AI; AI features layer on as gated capabilities (place extraction, smart suggestions).
- Privacy note: AI features explicitly *do* send image / OCR content off-device (that's what the LLM call is). This is a meaningful break from the v1.0 privacy posture and must be surfaced clearly to the user when AI is enabled, with opt-in per feature.

### Sharing (currently a forever non-goal)

- Not designed for. The `owner_id` column is the only concession.
- If ever revisited, requires accounts, real backend, and a permissions model — a different shape of app.

### Android

- Not in v1.0 scope. Adding it forces:
    - Replace `VisionOCR` with ML Kit Text Recognition.
    - Replace `ScreenshotObserver` with a `MediaStore` / `ContentObserver` equivalent.
    - Replace `ShareExtension` with an Android intent filter activity.
    - CloudKit can't go cross-platform; sync would need PowerSync, Electric, or own backend.
- The TypeScript app code is platform-agnostic, so the rebuild is concentrated in `native/` and the sync layer.

## Open questions

- Free tier trip cap (decide post-beta).
- Subscription pricing tiers (decide at v1.0 launch).
- Image storage location: `Documents/` (iCloud-backed-up) vs `Library/Application Support/`. Default to `Application Support/screenshots/` unless we explicitly want OS-managed iCloud Drive backup.
- OCR locale: device default vs auto-detection. Start with device locale; revisit if multilingual screenshots are common in beta.
- Number of OCR retry attempts before marking `failed` (start at 3).

## Non-goals

Restated from PRODUCT.md so they remain loud:

- Itinerary planner.
- Server-dependent heavy AI as a core flow. (A thin LLM proxy is acceptable; full server-side product features built on it are not.)
- Social or sharing features.
- Booking integrations.
