# Trip Pocket — Architecture

Solo working document. Companion to PRODUCT.md (what) and ROADMAP.md (when). This is the _how_, scoped through v1.0 with light forward-notes for v1.x.

## Scope

In scope:

- The shape of the iOS app from v0.1 capture loop through v1.0 App Store launch.
- Load-bearing technical decisions: storage, reactivity, native modules, paywall + trial, telemetry.
- Cheap forward-proofing for v1.x sync (and the no-op for sharing).

Out of scope:

- Step-by-step implementation plans — those live separately.
- Visual design / UX flows beyond what shapes architecture.
- Anything past v1.0 except as a "leave the door open" note.

## Stack at a glance

- **App runtime:** React Native via Expo SDK 55 prebuild + config plugins. EAS for dev / preview / production builds with `appVersionSource: remote` so EAS owns build numbers. Bare workflow not used.
- **Languages:** TypeScript across the JS side; Swift for the iOS native modules (share extension, Vision OCR, App Group defaults).
- **Storage:** SQLite (`expo-sqlite`) with FTS5 (trigram tokenizer) for search; image bytes as files in the app sandbox + App Group inbox.
- **Reactivity:** SQLite update-hook live queries via a small `useLiveQuery` hook backed by an event-bus invalidation signal; no Redux / Zustand / React Query.
- **Navigation:** Expo Router (file-based, typed routes), iOS 26 NativeTabs (liquid glass) inside the authenticated shell.
- **Styling:** NativeWind v5 + Tailwind v4 (`react-native-css` pipeline). Single token file (Sea+Teal palette, spacing, type scale); dark mode supported.
- **Monetization:** RevenueCat (`react-native-purchases`) wrapping StoreKit. Anonymous-only RC identity. Worker-side `requireEntitlement` middleware fronts the AI proxy.
- **Crash + analytics:** Sentry for crashes + non-fatals (JS + native, anonymous install UUID identity, sourcemaps uploaded by `eas-build-on-success`). Product analytics (PostHog) deferred — spec is written but unshipped; `modules/pipeline-log` covers per-source debugging in the interim.
- **Backend:** a thin AI / scraping proxy on Cloudflare Workers. No database; one Workers KV namespace (`EXTRACT_STATE`, 72h TTL) caches the share-time pre-warm orchestrator's per-`content_hash` state. Per-IP rate limit binding (100 req / 60s). Endpoints: `POST /extract` (orchestrator pre-warm — 202 + `ctx.waitUntil`), `GET /extract/:contentHash` (poll cached state), `POST /enrich`, `GET /photo/:name`. The Gemini LLM call (text / vision / video) is routed through **Cloudflare AI Gateway** → Google AI Studio, model `gemini-2.5-flash-lite`. The legacy public `POST /extract` (text/vision/video body) and `POST /fetch-post` routes were folded into internal helpers (`runExtract`, `runFetchPost`) the orchestrator drives directly. The device is still the source of truth for everything except the LLM calls and external scraping.
- **Platforms:** iOS only through v1.0. Android lives in the v1.x parking lot.

## Data model

All primary keys are UUIDs (generated client-side). Every long-lived row carries `created_at`, `updated_at`, and `owner_id`. `owner_id` is a UUID stamped at first launch — there's one owner ever in v1.0, but the column is the cheap concession to a hypothetical sharing future. Soft-delete was retired in 2026-05-10; deletes are hard, with symmetric orphan prune wired through the `place_sources` junction (see "Delete cascade" below).

The shape is **places-first**: each ingested item is a `source` (a screenshot file _or_ a shared IG/TikTok URL), and the AI extractor writes one or more `places` joined to the source through `place_sources`. FTS5 indexes the place document, not the source document — searching "tonkatsu" finds the place, not just the screenshot that contained the word.

Tables:

- `trips` — `id`, `name`, `color`, `owner_id`, `created_at`, `updated_at`.
- `sources` — `id`, `kind` (`image` | `url` | `pasted`), `platform` (`instagram` | `tiktok` | NULL for screenshots), `trip_id` (nullable; NULL = Inbox), `file_path` (image kind, or the worker-resolved cover for url kind), `url` + `caption` (url kind), `content_hash`, `origin` (`share` | `auto` | `manual`), `ocr_status`, `ocr_text`, `extraction_status`, `extraction_strategy` (nullable — `ocrTextLLM` / `vision` / `captionPlusVision` / `videoPlusCaption`; NULL legacy rows treated as `ocrTextLLM`), `fetched_via` (nullable — telemetry tag naming the worker `LinkFetcher` that resolved the URL), `extraction_paused_reason` (nullable), `enrichment_paused_reason` (nullable), `fetch_post_paused_reason` (nullable), `captured_at`, `owner_id`, `created_at`, `updated_at`. UNIQUE index on `content_hash` (SHA-256 of file bytes for images; SHA-256 of normalized canonical URL for url kind).
- `places` — `id`, `trip_id`, `name`, `city`, `country_code` (ISO-2), `category` (one of `food` / `drinks` / `stays` / `sights` / `activities` / `shops`, nullable), `normalized_key`, `external_place_id` (Google Place ID), `photo_name`, `description`, `rating`, `price_level`, `external_url`, `latitude`, `longitude`, `formatted_address`, `enrichment_status` (`pending` | `enriched` | `not-found` | `failed`), `enriched_at`, `enrichment_model`, `owner_id`, `created_at`, `updated_at`. UNIQUE on (`external_place_id`, `owner_id`) where `external_place_id IS NOT NULL`; non-unique index on `normalized_key` (same-name chains like "Starbucks in Tokyo" don't auto-collapse, the extractor enforces sole-match dedup).
- `place_sources` — junction: `place_id`, `source_id` (composite PK), `extracted_at`, `raw_text` (the OCR snippet the LLM used), `extracted_address`, `confidence`, `extraction_model`, `owner_id`, timestamps. One source can produce zero, one, or many places; one place can be backed by many sources.
- `pending_imports` — `id`, `kind` (`image` | `url`), `app_group_path` (image), `url` (url), `suggested_trip_id`, `created_at`. Written by the share extension, consumed by the main app on next foreground. Not synced.
- `pipeline_events` — `id`, `source_id`, `stage` (`url_fetch` | `image_download` | `ocr` | `extract` | `enrich`), `status` (`start` | `done` | `failed`), `error_summary` (closed vocabulary, never raw `.message`), `tags` (JSON for platform / error code), `occurred_at`. LRU-swept to ~1000 rows globally. Powers the Diagnostics screen and dev-only Metro firehose.
- `meta` — single-row key/value table for things like the migration version.
- `places_fts` — FTS5 virtual table (trigram tokenizer) indexing each place's name + city + description + concatenated `place_sources.raw_text` (capped 2 KB per source) + concatenated `extracted_address`. Triggers fan out across writes to `places` and `place_sources`.
- `sources_fts` — FTS5 virtual table indexing `sources.ocr_text` + parent trip name. (The legacy `tags` table was dropped in migration 0009; its triggers' tags subquery is gone too.)

**Retired tables / columns:**

- `tags` — never written to by app code, dropped in migration `0009_drop_tags`. The 3-bucket `kind` enum it carried (`place` / `food` / `activity`) was superseded by `places.category` and the 6-bucket taxonomy.
- `screenshots` — folded into `sources` during the places-first restructure. Migration `0004_rename_screenshot_to_image` rebuilds the `sources.kind` CHECK from `screenshot` to `image`.
- `deleted_at` — removed everywhere in 2026-05-10. Hard delete throughout.
- `extracted_places` — the original sketch's flat table. Replaced by `places` + `place_sources` so a place can outlive any one source.

## Module structure

App code (TypeScript / React):

- `app/` — screens, navigation, root layout. UI layer only, no business logic. Includes `app/onboarding/`, `app/(tabs)/`, `app/sources/[id]`, `app/places/`, `app/trips/[id]`, `app/triage.tsx`, `app/paywall-lapse.tsx`, `app/diagnostics/`.
- `components/` — shared presentation components (`PlaceTile`, `PlaceGrid`, `ProcessingBanner`, `InactiveEntitlementBanner`, `EmptyState`, `ErrorToast`, `ErrorFallback`, `FilterPills`, `TripPicker`, `Skeleton`, `StatusPill`, …). Sits outside `app/` so Expo Router doesn't try to route them.
- `modules/storage/` — SQLite schema, migrations, repositories, `useLiveQuery` hook, processing-status predicates. The _only_ place that touches SQL.
- `modules/capture/` — share-extension hand-off and manual camera-roll import. Computes content hashes, dedupes against `sources`, writes ingested rows.
- `modules/processing/` — OCR pipeline (single-image + carousel multi-image), content hashing, queue + retry + startup recovery, paused-state handling for entitlement.
- `modules/vision-ocr/` — Swift Expo Module wrapping Apple Vision `VNRecognizeTextRequest`, run off the main thread via `.runOnQueue`.
- `modules/extraction/` — AI extraction client. Builds the prompt, calls `POST /extract` with an `X-RC-User-Id` header, persists `places` + `place_sources` rows, drives sole-match dedup. Handles `entitlement-required` (HTTP 401) by pausing the source row.
- `modules/enrichment/` — Google-Places-via-proxy client. Calls `POST /enrich` and `GET /photo/:name`, writes the venue photo / rating / price level / lat-lng / formatted address / Google `display_name` back onto the place. Same entitlement-pause handling as extraction.
- `modules/pipeline-log/` — per-source observability. Public API: `startStage(sourceId, stage)`, then `stage.done()` / `stage.failed(errorSummary, tags?)`. Closed-vocabulary error summaries only; never logs raw `.message` or payload text. LRU-swept.
- `modules/search/` — FTS5 query helpers (`buildFtsMatch`, snippet formatting) and trip-filter logic.
- `lib/entitlement/` — `EntitlementProvider`, RC SDK init, status mapper (RC `CustomerInfo` → `{ active, plan, cachedUntil }`), plans config (yearly / weekly), `appUserId` helper for the proxy header, cached-status file for cold launch. The only place `react-native-purchases` is imported.
- `lib/observability/` — Sentry init + install-UUID identity. Pipeline-stage breadcrumbs were retired in favour of `modules/pipeline-log` (the breadcrumbs file was deleted on 2026-05-13).
- `lib/paywall/` — `openLapsePaywall()` and friends, the lapse-paywall route helper.
- `lib/toast/`, `lib/permissions/`, `lib/errors/` — error-handling pass surface area: toast emitter, photo-permission helper, `captureErrors` classifier.
- `lib/onboarding/` — answer state, demo fixtures (the 6-screen onboarding's tap-to-transform data).

Native iOS code (Swift, via Expo Modules):

- `native/ShareExtension/` — Share Extension target with custom SwiftUI. Trip picker, App Group inbox writer, entitlement gate (reads App Group `entitlement.status` UserDefaults set by the main app).
- `modules/vision-ocr/ios/` — Apple Vision wrapper.
- `modules/app-group-defaults/` (hand-written Expo Module) — read/write `UserDefaults(suiteName: "group.com.trippocket.shared")` from JS so the main app can publish entitlement state to the share extension.

Boundaries:

- `storage` is the only module that knows SQL exists. Everyone else asks `storage` for typed objects.
- `capture`, `processing`, `extraction`, `enrichment`, `pipeline-log`, `search` are _workflow_ modules — they orchestrate but don't own data.
- `lib/entitlement`, `lib/observability`, components in `components/` are _capability_ surface area for the UI.
- `app/` has minimal business logic — `app/_layout.tsx` is the orchestrator (entitlement provider, splash hold, foreground refresh, fan-out resume sweep across extraction / enrichment / processing).
- No "service" or "repository" layer above `storage`. Storage _is_ the repository. One layer of abstraction, not two.
- No global `models/` or `types/` folder. Types live with the module that owns them.
- An ESLint rule blocks direct imports of `react-native-purchases` and `@sentry/react-native` outside their owning module so the swap-points stay local.

## Key flows

### Ingestion: share extension (image)

1. User taps Share on a screenshot in Photos. "Trip Pocket" appears.
2. Native share extension UI (SwiftUI) reads the trip list from shared SQLite (App Group container) and checks the App Group `entitlement.status` UserDefaults (with a 7-day staleness fallback). If entitlement is inactive _and_ status is fresh, the extension surfaces a "Subscription needed" message instead of the picker.
3. User picks a trip (last-used pre-selected) or "Inbox".
4. Extension copies the image into the App Group container and writes a `pending_imports` row (`kind='image'`, `app_group_path`, `suggested_trip_id`).
5. Extension dismisses; user is back in Photos. Total time should feel like one extra tap.
6. On the main app's next foreground, `modules/capture`:
   - Reads `pending_imports`.
   - Moves the image to the main app sandbox.
   - Computes a content hash, dedupes against `sources` via the `content_hash` unique index.
   - Writes a `sources` row with `kind='image'`, `ocr_status='pending'`, the chosen `trip_id` (or `NULL`), `origin='share'`.
   - Deletes the `pending_imports` row.

The share extension is a _dumb mailbox_. It never runs OCR or anything memory-heavy — iOS extensions have ~120 MB and a few seconds of runtime, both easy to blow past. If the post-copy database write fails it removes its own staged file to keep Retry idempotent.

### Ingestion: share extension (URL) — share-time pre-warm

1. User taps Share on an Instagram or TikTok post inside those apps; the share sheet hands a `URL` to Trip Pocket (the extension's `Info.plist` declares `NSExtensionActivationSupportsWebURLWithMaxCount=1`).
2. Same entitlement gate, same trip picker.
3. Extension writes a `pending_imports` row (`kind='url'`, `url`, `suggested_trip_id`) — no file copy.
4. Extension fires a **background `URLSession` POST to the worker's `/extract` orchestrator** with `{ contentHash, kind: 'url', url, suggestedTripId? }` and `X-RC-User-Id` read from App Group `UserDefaults` (the main app mirrors the RC anonymous id there on launch). The host app's `AppDelegate.handleEventsForBackgroundURLSession` keeps the upload alive after the extension is killed by iOS. Goal: the pipeline starts _while the user is still in Photos_, so by the time they open Trip Pocket the result is cached.
5. The worker checks `EXTRACT_STATE` KV for that `content_hash`. Cache hit → 200 with the cached state. Cache miss → write `pending`, return 202, and schedule the orchestrator via `ctx.waitUntil` (Workers Paid plan affords ~5 min wall-clock — enough for Apify + Gemini video extraction). The orchestrator: calls `runFetchPost(url)` → writes `partial` state with caption + cover URL → picks the extract mode (video > vision > text) → calls `runExtract` → dedupes places → writes `done` (or `error`) state.
6. On the main app's next foreground, `modules/capture`:
   - Normalizes the URL (canonical IG / TikTok form), hashes it (SHA-256 of the normalized URL string), dedupes against `sources`.
   - Writes a `sources` row with `kind='url'`, `platform='instagram' | 'tiktok'`, `extraction_status='pending'`, `extraction_strategy=NULL` (stamped after fetch returns).
   - Hands the row to `pollExtract(contentHash)` which polls `GET /extract/:contentHash` until `status='done' | 'error'`. On `done` the client persists `places` + `place_sources` rows in one transaction (running the same cross-source `findSoleMatchByNormalizedKey` dedup as the device-side flow) and flips `sources.extraction_status='done'`.

Manual import inside the app uses `expo-image-picker` and the same trip-picker component, with `origin='manual'`. URL pasting follows the same code path as URL share (including the worker `/extract` call), with `origin='manual'`. The legacy in-app `enqueueUrlFetch` path was removed (commit `7dd0d19`, 2026-05-18); URL sources now go through the orchestrator exclusively.

(Screenshot / image-share pre-warm is **out of scope** for v1 of the orchestrator — screenshots stay on the on-device OCR + extract flow. v2 will add a `/upload` route + R2 bucket so image shares can pre-warm too.)

(Background screenshot auto-detect was originally listed here but is a permanent non-goal — share-sheet capture is the wedge. ROADMAP.md has the rationale.)

### Processing (OCR)

- `modules/processing` is invoked on app foreground if rows with `ocr_status='pending'` exist (and the source isn't entitlement-paused).
- Single-image case: pulls the file off disk and calls `modules/vision-ocr.recognizeText(path)`, which runs `VNRecognizeTextRequest` on a background dispatch queue via `.runOnQueue`.
- Carousel / slideshow case (IG carousel via Apify, TikTok photo slideshow via rehydration JSON): slides 2..N are downloaded to a temp directory, OCR'd individually, then deleted. Only the cover image is persisted to the app sandbox. `ocr_text` = concat of all slides + the original `caption` from the share.
- On success: writes `ocr_text`, flips `ocr_status='done'`. FTS updates via triggers.
- On failure: `ocr_status='failed'`, retried on next foreground up to N attempts (start at 3).
- On HTTP 401 (`entitlement-required`) from any worker call in the chain: source row gets a `*_paused_reason` value instead of `'failed'`, and the row is silently parked until the entitlement transitions back.
- All stage transitions emit `pipeline_events` rows so the Diagnostics screen can show the timeline.
- No iOS `BGTaskScheduler` in v1.0.

### Extraction (AI)

Extraction is **composable**: each source row carries an `extraction_strategy` stamped at import time (or after worker fetch for URL sources). The orchestrator dispatches to one of four strategies, all of which converge on a shared sole-match dedup + persist step.

**Strategies** (`modules/extraction/strategies/`):

- **`ocrTextLLM`** — original text-mode path. Runs Apple Vision OCR on the image, then sends `ocr_text` to the worker. Used for plain screenshots without EXIF GPS, and as the universal soft-degrade fallback.
- **`vision`** — sends the image bytes (base64) directly to Gemini in vision mode, skipping device-side OCR. Default for image shares without a caption hint.
- **`captionPlusVision`** — vision + an EXIF-derived "Photo taken in X" caption hint (camera photos with GPS), or, for URL sources, the post caption alongside the cover image. Lets the LLM ground place inferences in location signal it otherwise wouldn't have.
- **`videoPlusCaption`** — short video (IG Reel / TikTok video) + caption. Worker fetches the signed video URL itself (closer to the CDN than the phone, no cellular cost) and forwards bytes to Gemini either inline (<18 MB) or via Gemini's Files API (>=18 MB, with a `ctx.waitUntil`'d cleanup DELETE). Hard caps: 25 MB body, 90s duration — beyond either, fall back to `captionPlusVision` on the cover frame. The strategy may report `telemetry.fallbackUsed=true` so dashboards distinguish "video succeeded" from "video succeeded via fallback".

Strategy is selected by `strategyForImageImport` / `strategyForUrlAfterFetch` (`modules/extraction/strategies/select.ts`) from `app.config.extra.forceStrategy` (developer override, `auto` in production) plus row context (`hasCaption`, `hasFile`, `hasVideo`). Soft-degrade rules send missing prerequisites down the safe path — e.g. `force=video` on an image row picks `vision`; `videoPlusCaption` without a cover file falls all the way back to `ocrTextLLM`.

**Flow:**

- After a row becomes eligible (text strategies wait for `ocr_status='done'`; vision/video strategies need only `file_path`), `modules/extraction` enqueues it.
- Pre-flight: checks `lib/entitlement.isEntitled()`. If inactive, the row gets `extraction_paused_reason='entitlement'` and is parked. (The entitlement gate is also enforced server-side — see "Worker auth".)
- The strategy posts the appropriate request shape to the worker with `X-RC-User-Id`:
  - text mode: `{ mode: 'text', text }` (or the legacy `{ ocr_text }` alias the worker still accepts for one release)
  - vision mode: `{ mode: 'vision', imageBase64, caption? }`
  - video mode: `{ mode: 'video', video: { url, durationSec? }, caption? }`
  - URL-source orchestrator: `pollExtract(contentHash)` against `GET /extract/:contentHash`, which returns the worker-side composed result (worker picks the mode based on what `runFetchPost` resolved).
- Worker forwards to **Gemini 2.5 Flash-Lite** via **Cloudflare AI Gateway** (`gateway.ai.cloudflare.com/v1/{accountId}/{gatewayName}/google-ai-studio/...`) authenticated with a `cf-aig-authorization` bearer (Authenticated Gateways). Fixed `SYSTEM_PROMPT` + structured `responseSchema` returning `{ places: [{ name, city, address, category, country_code }] }`. Video mode appends a `VIDEO_PROMPT_SUFFIX` reminding the model to read on-screen text overlays carefully (Reel place mentions live in title cards, not the caption). Empty array = noise classifier (the LLM is allowed to say "no places here").
- On response, `modules/extraction` runs per-call dedup (case-insensitive `name + city + address`), then sole-match dedup against existing `places` by `normalized_key` scoped to owner. Writes new `places` rows or attaches a `place_sources` junction to an existing place; either path runs `name`, `city`, `country_code`, `category` through asymmetric-fill rules so a previously-NULL field can be filled by a later extraction, but a non-NULL value is never overwritten (enrichment from Google Places is the only path that overwrites). `address` is persisted on the junction row (`place_sources.extracted_address`) and forwarded to `/enrich` as a hint.
- Failure modes (network down, proxy 5xx, LLM bad JSON): `extraction_status='failed'`, retried on next foreground up to 3 attempts. 401 pauses instead. 429 defers via `retry-after` without consuming the budget.
- Single-flight discipline: one source at a time on-device. No background extraction in v1.0 — the share-time pre-warm orchestrator runs in the worker, not the phone.

### Enrichment

- After a place row is written, `modules/enrichment` calls `POST /enrich` (with `X-RC-User-Id`) which fans out to Google Places `searchText` → `places/{id}` → a short Gemini narrative, all keyed `languageCode=en`. Returns Google Place ID, `display_name` (canonical English name), `photo_name` (resolved via `GET /photo/:name`), lat/lng, formatted address, rating, price level, country code, and description.
- Google's `display_name` becomes the canonical `places.name` (overwrites the LLM's name), and `normalized_key` is recomputed in TypeScript before the write. This collapses casing / punctuation duplicates like "joe's pizza & bar" + "Joe's Pizza" once both have resolved to the same Place ID.
- Three write paths handled: no-collision (insert), merge-winner (existing place gets enriched fields), merge-skip (different non-null trips — keep both rows, write descriptive fields but withhold `external_place_id` to satisfy the UNIQUE index).
- Same 401-pause semantics as extraction.

### Fetch-post (URL resolution — internal helper)

`runFetchPost(url)` lives in `workers/extract-proxy/src/fetch-post.ts` and is invoked by the orchestrator (no public HTTP route — the legacy `POST /fetch-post` was removed when the share-time pre-warm orchestrator landed). It resolves an IG or TikTok URL to `{ platform, permalink, caption, imageUrls, author, videoUrl?, videoDuration?, _debug }`, dispatched via the pluggable `LinkFetcher` chain (`src/fetchers/`):

- **IG `/p/` posts:** og:\* fast path on the canonical URL. Uses the base64-decoded `efg` query param on `og:image` to classify single / carousel / clips cheaply. Singles ship og only; carousels (and unknown `efg`) escalate to Apify (`apify~instagram-post-scraper`) for slides 2..N.
- **IG `/reel/` and `/tv/`:** with Apify configured, **skip og: entirely and go straight to Apify** — IG's production Reel HTML no longer exposes `og:video*` so the round-trip is pure latency. Without Apify configured, soft-degrades to og: (cover + caption only, no video extraction).
- **TikTok primary:** parse `__UNIVERSAL_DATA_FOR_REHYDRATION__` script-tag JSON (`data.__DEFAULT_SCOPE__['webapp.reflow.video.detail'].itemInfo.itemStruct`). Recovers all photo-slideshow slides; discriminates photo vs video via `imagePost`; extracts `playAddr` / `downloadAddr` for video mode.
- **TikTok fallback:** oEmbed (officially documented; safety net when the rehydration parser fails — anti-bot stub, schema drift, deleted post).
- **Caching:** Apify-backed responses get `Cache-Control: public, s-maxage=604800` (7 days); og-only / TikTok rehydration get 1 day (TikTok signed URLs expire ~47h). Errors get `Cache-Control: no-store` so a transient Apify outage doesn't poison a URL for the full success TTL.
- **`_debug` echo** (closed vocabulary: `route`, `ogOutcome`, `apifyOutcome`, `cacheHit`) is forwarded by the client into the pipeline log's `url_fetch` stage so `wrangler tail` isn't needed to see which path the worker took.
- Apify is gated by `APIFY_TOKEN` + `APIFY_ACTOR_ID` Wrangler secrets; soft-degrades to "not configured" when unset.

### Browse / search

- **Inbox:** `sources` with `trip_id IS NULL` and no `*_paused_reason`, ordered by `captured_at desc`.
- **Trip detail:** two sub-tabs.
  - **Places:** rows from `places` for that trip, grouped by country (section headers shown only when the trip spans more than one country). Each tile carries a category icon (one of six SF Symbol buckets) plus venue photo / name / city.
  - **Sources:** the image / URL grid for that trip.
- **Places (per-source):** "place detected" badge in the source-detail toolbar; tap opens a sheet listing the places extracted from that source.
- **Place detail:** full-bleed hero photo (skeleton while enriching), description, rating + price, address, Open-in-Maps action — `comgooglemaps://` if installed, else Apple Maps via `https://maps.apple.com/?...`.
- **Search:** FTS5 query against `places_fts` (place name, city, country, description, place_sources.raw_text, extracted_address) and `sources_fts` (OCR text, trip name) with trip-filter chips. Searching "tonkatsu" finds the place whose `name='Maru Tonkatsu'` even if "tonkatsu" never appeared verbatim in OCR.
- All list views use `useLiveQuery` and re-render automatically as ingestion / OCR / extraction / enrichment / triage completes.

### Delete cascade

- Hard delete throughout. No `deleted_at` column on any table.
- Deleting a source removes its `place_sources` rows; any place whose only junction was to that source is then pruned.
- Deleting a place removes its `place_sources` rows; any source whose only junction was to that place is also pruned (symmetric cleanup so orphan sources don't linger after a "delete this place" tap).
- Deleting a trip has two modes: **untriage** (default — sources moved to Inbox, places retained) and **cascade** (opt-in — all sources + places + junctions in the trip removed).
- The triage CTA tray has a tertiary Delete row for source-level removal from inside triage.

## Native iOS modules

A handful of small Swift modules, each ~100–300 lines. We own them — community packages in this niche tend to go unmaintained, and we need precise control (e.g., the share extension reads our SQLite directly).

### ShareExtension

- iOS Share Extension target with custom SwiftUI.
- Trip picker + Save button. Reads the trip list from shared SQLite at `group.com.trippocket.shared` (`TripReader.swift`).
- Accepts both image attachments and URLs (via `NSExtensionActivationSupportsWebURLWithMaxCount=1` in `Info.plist`).
- Entitlement gate: `EntitlementReader.swift` reads `entitlement.status` from App Group `UserDefaults` with a 7-day staleness fallback; renders a "Subscription needed" UI when inactive and fresh.
- For image shares: streams bytes to disk under the App Group container; never holds a full `UIImage` in memory.
- `PendingImportWriter.swift` writes the `pending_imports` row (either `kind='image'` with `app_group_path`, or `kind='url'` with `url`). Removes the staged file on post-write failure so Retry stays idempotent.

### VisionOCR (`modules/vision-ocr/ios`)

- Wraps `VNRecognizeTextRequest`.
- Exposes `recognizeText(imagePath, locale?) → string` to JS.
- Runs on a background dispatch queue via Expo Modules' `.runOnQueue`.
- Returns concatenated text only — no bounding boxes; we don't need them yet.

### app-group-defaults

- Tiny Expo Module wrapping `UserDefaults(suiteName: "group.com.trippocket.shared")`.
- Lets the main app publish entitlement state (and a timestamp) that the share extension reads from a process that can't talk to RevenueCat directly.

(The originally-planned `ScreenshotObserver` module was never built — background screenshot auto-detect is a permanent non-goal; see ROADMAP.md.)

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
- **Pre-v0.3 dev DB wipe.** While there were no users, schema changes that would otherwise require a migration were sometimes applied by editing `0001_init.ts` in place rather than carrying old shapes forward. To pick up such a change locally: long-press the simulator app → Remove app → Delete, or remove `trip-pocket.db` from the simulator app sandbox. The shape stabilised before TestFlight; from `0002_url_share.ts` onward all schema changes ship as proper numbered migrations.
- Currently shipped migrations: `0001_init`, `0002_url_share`, `0003_pending_imports_nullable_path`, `0004_rename_screenshot_to_image`, `0005_pipeline_events`, `0006_country_search`, `0007_entitlement_paused_reason`, `0008_category_rename`, `0009_drop_tags`, `0010_extraction_strategy_columns`.

### Paywall + trial (v1.0 — shipped)

The app is paid from day one. There is no free tier.

- **RevenueCat** (`react-native-purchases`) wraps StoreKit. Receipt validation server-side (RevenueCat's), entitlements + dashboard, no babysitting StoreKit edge cases (refunds, family sharing, sub-state changes, intro-offer eligibility).
- Products: **`pocket_yearly`** ($39.99/yr, 7-day trial) and **`pocket_weekly`** ($3.99/wk, 3-day trial). Plans configured as an array in `lib/entitlement/plans.ts`; the paywall renders tiles + trial copy from the RC offering.
- Anonymous-only RC identity (`$RCAnonymousID:<uuid>`), cached to a file at first launch so it survives RC SDK init failures and is available before the SDK is up.
- Single entitlement: `pro`. Granted while in trial _or_ on an active paid subscription. RC treats both states identically.
- `lib/entitlement` is the only place RevenueCat is imported. `EntitlementProvider` (mounted above the ready-guard in `app/_layout.tsx`) exposes `{ status, refresh }`. Status is synchronous from cached state, refreshed on foreground, on SDK customer-info events, and via the manual `refresh()` after the paywall flow returns.
- **First-launch gate:** new users land on onboarding (`app/onboarding/*`) → paywall (`app/onboarding/paywall.tsx`). Splash is held until entitlement status resolves so the user never sees the app shell before the gate.
- **Lapse handling:** when entitlement flips inactive on the active session, the foreground hook routes to `/paywall-lapse` (separate root modal, not the onboarding paywall). Read-only behaviour stays in the app shell — `<InactiveEntitlementBanner>` is shown, in-flight pipeline rows pause instead of failing, and the resume sweep fires automatically on the next transition back to active.
- **Server-side gate (`requireEntitlement` middleware):** the worker validates every `/extract`, `/enrich`, and `/fetch-post` request by reading `X-RC-User-Id` from the request, hitting RC REST `GET /v1/subscribers/{id}`, and checking `entitlements.pro.expires_date` against `now`. 60s edge cache to keep cost down. Empty / unknown subscriber → 401. Server-side gate is the security boundary; the client gate is a UX hint.
- **Paused-state pipeline:** 401 from the worker translates to a `*_paused_reason='entitlement'` column on the affected `sources` row (per stage: `extraction_paused_reason`, `enrichment_paused_reason`, `fetch_post_paused_reason`). Rows in paused state are excluded from the processing predicate, surface as a `<PausedBadge>` in lists, and are picked up by the fan-out resume sweep in `app/_layout.tsx` when entitlement transitions inactive → active.
- **Share-extension entitlement gate:** the main app mirrors `{ active, status_updated_at }` into App Group `UserDefaults` via `modules/app-group-defaults`. The extension reads it directly (no IPC); if status is fresh and inactive, the share UI is replaced with a "Subscription needed" message. Staleness threshold is 7 days — beyond that the extension fails open so a long-uninstalled main app doesn't break capture.

### Observability + telemetry

- **Sentry (client)** for crash + non-fatal error reporting (`lib/observability/sentry.ts`). Initialized in `app/_layout.tsx` and gated on `!__DEV__`. Anonymous install-UUID identity persisted via `expo-application` so the same device is correlated across sessions without tying to RC's app-user-id. `tracesSampleRate: 0`, `sendDefaultPii: false`. Branded `<ErrorFallback>` for the JS error boundary. Sourcemaps uploaded by the `eas-build-on-success` script, pinned to the runtime release string. `lib/extract/pollExtract.ts` emits `extract.poll` breadcrumbs at start, on every POST trigger (initial + stale-recovery), and at every final outcome — so any user-visible error downstream comes with a full trail of the share→poll→render flow.
- **Sentry (worker)** via `@sentry/cloudflare` — the worker's default export is wrapped with `Sentry.withSentry` (`workers/extract-proxy/src/index.ts`). Each `orchestrate()` call opens a `Sentry.withIsolationScope` so tags don't leak across concurrent shares. `SENTRY_DSN` is a Wrangler secret (optional — when unset the SDK runs as a silent no-op for local dev). The DSN can point at the same project as the client; tag-based filtering separates client vs worker issues.
- **Worker structured logging** (`workers/extract-proxy/src/logger.ts`) emits one JSON line per stage transition: `share_received` → `stage_start fetch-post` → `stage_done fetch-post` → `stage_start extract` (per fallback mode) → `stage_done enrich` → `stage_done blurb`. Stable fields: `event`, `stage`, `contentHash` (per-share trace id), `source` (`instagram`/`tiktok`), `mode` (`video`/`vision`/`text`), `duration_ms`, `error_code` (closed-vocab token, never raw `.message`). `logStageError` does both the JSON log and a `Sentry.captureException` with the same fields promoted to tags. The JSON shape is the same in Workers Logs (7-day retention via `[observability]` in `wrangler.toml`) and `wrangler tail` (live), so a single grep on `contentHash` works in either surface. See `docs/PIPELINE_DEBUGGING.md` for the query cheat-sheet.
- **Pipeline observability (client)** (`modules/pipeline-log`) handles the developer-facing "what happened to this specific source" question via the `pipeline_events` SQLite table. Public API is intentionally narrow: `startStage(sourceId, stage)` returns a `Stage` handle with `done()` / `failed(errorSummary, tags?)`. `error_summary` is a closed vocabulary enum, never raw `.message`. Available everywhere via the Settings → Diagnostics → Pipeline log screen, plus a dev-only Metro firehose gated on `__DEV__` AND an opt-in toggle.
- **PostHog product analytics** is specced (`docs/superpowers/specs/2026-05-12-telemetry-design.md`) but **not yet shipped**. When it lands it'll live in `modules/telemetry/`, defines events as a typed vocabulary (~30 events), uses the same install UUID as `distinct_id` so Sentry + PostHog join cleanly, and exposes a Settings → Privacy opt-out toggle (default on). An ESLint rule already blocks direct `posthog-react-native` imports outside the module so the seam is preserved.
- **Privacy:** observability never sees content — image bytes, OCR text, captions, and trip names do not flow to Sentry, the worker logs, or (eventually) PostHog. Logs are structural (which screen, which stage, which error class). `pipeline_events` and the worker `logger.ts` both restrict themselves to closed-vocabulary error codes.
- **Privacy (AI):** AI extraction explicitly _does_ send OCR text off-device to the proxy and onward to the LLM. Image bytes still don't leave the device for `/extract` (they do leave for `/fetch-post` URL captures, where the worker fetches the public IG/TikTok image itself; the original screenshot bytes still never leave). This is disclosed during onboarding (before the paywall) and in the privacy policy. Because every entitled user has access to AI extraction, the disclosure runs once during onboarding rather than per-trigger.

### Error handling

- Imperative single-slot toast (`lib/toast/toast.ts` + `<ErrorToast>` mounted at root) for transient failures (e.g., partial / total camera-roll import failures).
- Photos permission denial: alert with an "Open Settings" deep link via `lib/permissions/photos.ts`.
- Share-extension write failure: inline Retry / Cancel UI inside the extension; the staged App Group file is cleaned up on partial failure so Retry stays idempotent.
- Storage-full: detected pre-import via `pickPhotosForImport`; surfaced as a blocking banner.
- OCR / extraction / enrichment failures: silent in UI (the source / place is still browsable), retried on next foreground up to N attempts. The Diagnostics screen surfaces the actual stage outcomes for debugging.
- All non-trivial error paths flow through `lib/errors/captureErrors.ts` → Sentry.

### Testing

- Unit tests for pure-logic modules: `processing`, `extraction` (mocking the proxy), `search`, `storage` repositories. Jest.
- Native modules: smoke-tested manually on device. Not unit-tested; cost / value is wrong for solo dev at this stage.
- E2E: deferred. Maestro is on the table for v0.3+ if it pays back.

### AI / scraping proxy

The proxy is the only piece of server-side infrastructure. Keep it boring.

- **Runtime:** Cloudflare Workers (`workers/extract-proxy/`, Wrangler 4). Mostly stateless — one Workers KV namespace + one Rate Limit binding.
- **Bindings / vars (`wrangler.toml`):**
  - `EXTRACT_STATE` KV — share-time pre-warm orchestrator state keyed by `content_hash`. State machine: `pending → partial → done` (or `error`). 72h `expirationTtl` on each put; stale `pending` / `partial` older than 5 min is presumed dead and re-orchestrated.
  - `RATE_LIMIT` unsafe ratelimit binding — 100 req / 60s per `CF-Connecting-IP`. Cheap insurance against a leaked URL being abused.
  - `CF_ACCOUNT_ID` + `AI_GATEWAY_NAME` vars (public) — Cloudflare AI Gateway routing.
  - `APIFY_ACTOR_ID` var (default `apify~instagram-post-scraper`, swappable per env).
  - Secrets: `GEMINI_API_KEY` (Google AI Studio, forwarded as `?key=`), `GOOGLE_PLACES_API_KEY` (Maps Platform, restricted to Worker egress IPs), `CF_AIG_TOKEN` (AI Gateway Authenticated Gateways bearer), `APIFY_TOKEN`, `RC_REST_API_KEY` (RevenueCat REST, server-side), `SENTRY_DSN` (optional — wires the worker into Sentry via `@sentry/cloudflare`; absent = silent no-op).
- **Endpoints:**
  - `POST /extract` — share-time pre-warm orchestrator. Body: `{ contentHash, kind: 'url', url, suggestedTripId? }`. Cache hit → 200 with the cached `OrchestratorState`. Cache miss → 202 `{ status: 'pending' }` and schedules `orchestrate()` via `ctx.waitUntil`. The orchestrator runs `runFetchPost` → writes `partial` with caption + cover URL → picks extract mode (video > vision > text) → calls `runExtract` → dedupes via `dedupePlaces` → writes `done` (or `error`). Workers Paid plan affords ~5 min wall-clock — comfortably more than the 95th-percentile real pipeline wall-clock for video extractions.
  - `GET /extract/:contentHash` — poll the cached state. 200 with `OrchestratorState`, or 404 `{ status: 'missing' }` when the TTL expired / orchestrator was never triggered. Client uses this from `pollExtract` on app foreground.
  - `POST /enrich` — body `{ extracted_place_id, name, city, address?, ocr_caption }`. Fans out to Google Places `searchText` (with `languageCode=en`) → `places/{id}` for details → a short Gemini narrative. Returns either `{ status: 'enriched', external_place_id, display_name, city, country_code, photo_name, description, rating, price_level, latitude, longitude, formatted_address, external_url, model, _debug }` or `{ status: 'not-found', _debug }`. `_debug` carries closed-vocab per-step outcomes (`searchOutcome`, `detailsOutcome`, `blurbOutcome`).
  - `GET /photo/:name` — image proxy that resolves a Google Places photo name to bytes, resized to the client-requested width. Unauthenticated (passthrough for already-extracted names, no marginal LLM cost).
- **Internal helpers (no HTTP surface):**
  - `runExtract(body, env, ctx)` — pure wrapper around the Gemini call. Accepts the three internal request modes (`text` / `vision` / `video`) and returns `{ places, model }`. Throws `RunExtractError(code, status, retryAfter?)`. Used by the orchestrator and by an older direct-call path the test suite still exercises.
  - `runFetchPost(url, env)` — pure wrapper around the `LinkFetcher` chain. Returns `{ result, cacheKind }`. Throws `RunFetchPostError(code, status)`.
- **LLM call:** Gemini 2.5 Flash-Lite (`gemini-2.5-flash-lite`) via Cloudflare AI Gateway → Google AI Studio (`/v1beta/models/{model}:generateContent`). Fixed `SYSTEM_PROMPT` + `responseSchema` ⇒ structured JSON guaranteed. Video mode appends `VIDEO_PROMPT_SUFFIX`. Prompt and model are server-pinned; the client doesn't choose. The gateway gives us caching / analytics / a single chokepoint for upstream provider swaps.
- **Video transport (Gemini Files API):** for inputs <18 MB the worker inlines `inline_data`; for >=18 MB and up to 25 MB it does a resumable upload to Gemini's Files API and references the resulting `file_uri` in `file_data`. The Files API upload bypasses AI Gateway (file lifecycle isn't a generative request); the actual `generateContent` call still flows through the gateway. The DELETE-after-use runs through `ctx.waitUntil` so the response isn't blocked on cleanup. Hard rejects: video > 90s duration or > 25 MB body.
- **Auth:** `requireEntitlement` middleware on `POST /extract`, `GET /extract/:hash`, and `POST /enrich`. Validates `X-RC-User-Id` header (shape + RC REST `/v1/subscribers/{id}` with 60s edge cache). 401 on no header / invalid header / expired entitlement. `/photo` is unauthenticated. The client treats 401 as a pause signal (see "Paused-state pipeline").
- **Apify:** secondary scraping path for IG carousels and TikTok backups. Soft-degrades to "not configured" when `APIFY_TOKEN` is unset so dev environments don't need a paid token. 7-day cache on Apify-backed responses (set via `Cache-Control: public, s-maxage=604800`).
- **Logging:** structured JSON via `src/logger.ts` — one line per stage transition (`share_received`, `stage_start`/`done`/`warn`/`error` for `fetch-post` / `extract` / `enrich` / `blurb`, plus `share_cache_hit` / `orchestrate_skip` / `orchestrate_stale_pending`). Stable fields: `event`, `stage`, `contentHash` (per-share trace id), `source`, `mode`, `duration_ms`, `error_code`. Closed vocabulary; no OCR text, captions, or LLM response bodies ever appear in logs. Errors are also forwarded to Sentry with the same fields promoted to tags (`stage`/`source`/`mode`/`error_code`) via `Sentry.withIsolationScope` per share. The `_debug` echo on `/extract` and `/enrich` responses is a separate surface — it's for the client diagnostics screen, not server-side logging. Retention: 7 days in Workers Logs (`[observability]` enabled in `wrangler.toml`), plus Sentry for the error subset. See `docs/PIPELINE_DEBUGGING.md` for the query cheat-sheet.
- **Privacy:** the proxy persists no content. KV only carries the structured pipeline state (caption + cover URL + final `places[]` shape), TTL'd at 72h. It forwards, transforms, and returns.
- **Cost ceiling:** at expected volume the LLM, Places, and Apify costs are small; the worker primarily exists to keep API keys off-device, run the share-time pre-warm, and enforce the entitlement gate.

The device-side `modules/extraction`, `modules/enrichment`, and `modules/capture` (orchestrator poll for URL sources) are the only clients. The iOS share extension is also a client (it fires the `POST /extract` pre-warm via background `URLSession`). If we ever need a third client (backfill script, etc.) it talks to the same endpoints with its own RC user identity.

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

Resolved (kept for the record):

- ~~Subscription pricing~~ — Yearly $39.99 (7-day trial) + Weekly $3.99 (3-day trial); monthly dropped (2026-05-14, weekly lowered to $3.99 on 2026-05-16).
- ~~Paywall placement~~ — after onboarding for first-launch; separate `/paywall-lapse` root modal for lapse.
- ~~LLM provider~~ — Gemini 2.5 Flash-Lite (`gemini-2.5-flash-lite`) via Cloudflare AI Gateway → Google AI Studio.
- ~~Proxy runtime~~ — Cloudflare Workers + one Workers KV namespace (`EXTRACT_STATE`) + a `RATE_LIMIT` binding.
- ~~Where does the URL-share pipeline run?~~ — In the worker, kicked off at share time via background `URLSession` from the iOS share extension. The phone polls `GET /extract/:contentHash`. Replaces the old on-device "fetch-post + extract" two-call client flow (2026-05-17 share-time pre-warm).
- ~~Single-strategy extraction vs multi-mode?~~ — Multi-mode. Strategies (`ocrTextLLM` / `vision` / `captionPlusVision` / `videoPlusCaption`) are stamped on `sources.extraction_strategy` at import time and dispatched by the orchestrator (2026-05-16 extraction-pipeline composability).
- ~~Video extraction transport~~ — Inline `inline_data` for <18 MB; Gemini Files API for 18–25 MB with `ctx.waitUntil`'d cleanup. 90s duration ceiling.

Still open:

- OCR locale: device default vs auto-detection. Start with device locale; revisit if multilingual posts are common in beta.
- Number of OCR / extraction retry attempts before marking `failed` (currently 3). Same default for enrichment retries.
- API key separation for Google Places — single `GOOGLE_API_KEY` shared with Gemini, or a dedicated `GOOGLE_PLACES_API_KEY`. Decide when usage warrants the split.
- When (or whether) to ship `modules/telemetry` (PostHog). Pipeline-log + Sentry cover the v0.3 needs; the question is whether we want product-funnel analytics for v1.0 launch.

## Non-goals

Restated from PRODUCT.md so they remain loud:

- Itinerary planner. (Place extraction is _not_ the same thing as itinerary building.)
- Server-side product logic. The proxy is a stateless LLM passthrough; product features live on the device.
- Social or sharing features.
- Booking integrations.
