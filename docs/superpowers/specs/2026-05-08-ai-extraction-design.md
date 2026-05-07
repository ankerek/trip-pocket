# AI Place Extraction — Design

**Date:** 2026-05-08
**Status:** ready for review
**Roadmap:** v0.2, item 2 of the sequenced pipeline (OCR ✅ → **AI extraction** → classifier-gated auto-detect). Consumes `screenshots.ocr_text` and produces `extracted_places` rows with geocoded coordinates, plus the per-screenshot "has places" classifier signal that the auto-detect spec will gate on.

## Goal

Turn each screenshot's OCR text into 0..N tappable, geocoded places. After this ships:

- A pin badge appears on every thumbnail with ≥1 extracted place (Inbox + trip detail grids).
- Each screenshot's detail screen shows a "Places" section listing its extracted places; tapping a place opens Apple Maps at the geocoded location.
- Each trip's detail screen gains a "Places" tab listing distinct extracted places across that trip's screenshots, tap-to-Maps.
- The 0-place classifier signal is recorded for every processed screenshot but **not** used to hide content in v0.2 — share-sheet and manual imports remain visible regardless. Auto-detect (next spec) is the consumer.

The pipeline is invisible by default: places appear seconds after OCR completes, in the background.

## Non-goals

- Auto-detect of new screenshots. Sequenced after this; explicitly deferred.
- Google Maps deep-links. Apple Maps only for v0.2 (PRODUCT.md mentions both; iOS-first MVP picks one). Revisit if beta users complain.
- In-app map view of saved places. v1.x.
- Auth on the proxy. Lands at v1.0 alongside the paywall (per ROADMAP.md).
- Per-call latency / accuracy dashboards. Manual log inspection is fine for solo dev. Sentry wires in v0.3.
- Re-extraction when something upstream changes. Once a screenshot is `extraction_status='done'`, it stays done until the row is hard-deleted. OCR text is treated as immutable.
- FTS expansion to include extracted place names + cities. The OCR text already contains the name in the common case; inferred-city search lands in a later spec if it actually proves to be a problem.
- Manual editing of extracted places. View-only in v0.2.
- Manual tagging via the day-one `tags` table. That's a separate v0.2 surface; it is not the same concept as `extracted_places.category` (LLM-inferred per place vs. user-applied per screenshot).
- Re-geocoding when MKLocalSearch's catalog updates. One-shot at extraction time.

## Context

The day-one schema (migration `0001_init.ts`) already has:

- `screenshots.extraction_status TEXT NOT NULL DEFAULT 'pending' CHECK (extraction_status IN ('pending','done','failed'))`.
- `extracted_places(id, screenshot_id, name, city, category, raw_text, confidence, extraction_model, owner_id, created_at, updated_at, deleted_at)`.

What's missing:

- The geocoding columns on `extracted_places` (latitude, longitude, formatted_address, apple_maps_url).
- A native module that runs `MKLocalSearch`.
- A Cloudflare Worker that proxies a Gemini call.
- A `modules/extraction` module that owns the extraction lifecycle (queue, retry, sweep, startup recovery).
- The chain from OCR success → extraction enqueue.
- Per-screenshot pin badge in thumbnails.
- Per-screenshot "Places" section in detail.
- Per-trip "Places" tab.

## Architecture

```
                       ┌─────────────── on device ────────────────┐
                       │                                          │
[OCR processOne done]  │  modules/extraction                      │
        │              │  ┌────────────────────────────────────┐  │
        │ enqueue      │  │ serial Promise queue (single       │  │
        └─────────────▶│  │ in-flight, dedup set)              │  │
                       │  └─────────────────┬──────────────────┘  │
                       │                    │                     │
                       │                    ▼                     │
                       │     fetch(POST <PROXY_URL>/extract)──┐   │
                       │                                      │   │
                       └──────────────────────────────────────┼───┘
                                                              ▼
                              ┌────────────────────────────────────┐
                              │  Cloudflare Worker                 │
                              │  workers/extract-proxy             │
                              │  ↓                                 │
                              │  rate-limit binding                │
                              │  ↓                                 │
                              │  Gemini 2.5 Flash-Lite             │
                              │  responseSchema (strict JSON)      │
                              └─────────────────┬──────────────────┘
                                                │
                                                ▼
                                  { places: [{name, city, category}] }
                       ┌────────────────────────┼─────────────────┐
                       │                        ▼                 │
                       │  for each place →                        │
                       │    AppleGeocoder.search(name, city)      │
                       │           │ (native MKLocalSearch)       │
                       │           ▼                              │
                       │  { lat, lng, addr, mapsUrl } | null      │
                       │           │                              │
                       │           ▼                              │
                       │  INSERT INTO extracted_places (txn)      │
                       │  UPDATE screenshots                      │
                       │    SET extraction_status='done'          │
                       │           │                              │
                       │           ▼                              │
                       │  notifyChange('extracted_places',        │
                       │               'screenshots')             │
                       └──────────────────────────────────────────┘
```

```
[Inbox / Trip detail thumbnail with place_count > 0]
        │
        ▼
   pin badge overlay (bottom-right of thumbnail)

[places/[id] — screenshot detail]
   ├─ existing image
   ├─ existing OCR text panel
   └─ NEW: "Places" section (when ≥1)
        ├─ row: name • city • category icon • → Apple Maps
        └─ row: ...

[trips/[id] — trip detail]
   ├─ NEW: tab toggle "Photos" | "Places"
   │       (the existing grid is the Photos tab content)
   └─ Places tab: list of distinct (LOWER(name), LOWER(city)) tuples
        └─ row: name • city • category icon • → Apple Maps
```

Three new components, plus DB and UI surface changes:

1. **The proxy** — Cloudflare Worker (`workers/extract-proxy/`). Stateless. Single endpoint `POST /extract`. Calls Gemini, returns JSON. Per-IP rate limit via Cloudflare's Rate Limiting binding.
2. **`modules/extraction`** — TS module mirroring `modules/processing` (queue, retry, sweep, startup recovery, factory + provide/get singleton).
3. **`native/AppleGeocoder`** — small Expo Module wrapping `MKLocalSearch`.

## Components

### `workers/extract-proxy/` — new Cloudflare Worker

Layout:

```
workers/extract-proxy/
  src/
    index.ts        ← fetch handler
    prompt.ts       ← system prompt (cacheable, stable)
    schema.ts       ← Zod schema mirroring Gemini's responseSchema
  wrangler.toml
  package.json
  tsconfig.json
  README.md         ← deploy notes
```

**Endpoint:** `POST /extract`. Request body: `{ "ocr_text": string }`. Response body on success: `{ "places": [{ "name": string, "city": string, "category": "place" | "food" | "activity" }] }`. On failure: `{ "error": string }` with HTTP 4xx/5xx.

**`category` values.** `food` for restaurants/cafés/bars/markets, `activity` for things to do (hikes, museums, tours, viewpoints, day-trips), `place` for everything else (hotels, neighborhoods, generic locations). The system prompt enumerates these explicitly. The DB column has no CHECK constraint (matches existing schema), so unknown categories from a future model wouldn't break the insert; the app validates on the proxy side via Zod and rejects with 502 if Gemini returns an out-of-enum value.

**Why a category enum at all** (rather than free-form string): Trip detail's Places tab will eventually want a category icon per row. A small fixed enum keeps the icon mapping trivial.

**Gemini call** uses `responseSchema` (Google's "controlled generation") for structural JSON guarantees:

```ts
{
  model: "gemini-2.5-flash-lite",
  contents: [{ role: "user", parts: [{ text: ocrText }] }],
  systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
  generationConfig: {
    responseMimeType: "application/json",
    responseSchema: {
      type: "OBJECT",
      properties: {
        places: {
          type: "ARRAY",
          items: {
            type: "OBJECT",
            properties: {
              name:     { type: "STRING" },
              city:     { type: "STRING" },
              category: { type: "STRING", enum: ["place", "food", "activity"] }
            },
            required: ["name", "city", "category"]
          }
        }
      },
      required: ["places"]
    }
  }
}
```

The Worker still Zod-validates the response as defense-in-depth; on validation failure it returns 502 (the client treats 5xx as retryable).

**System prompt (rough draft, ~250 tokens):**

> You extract travel places from OCR text of social-media screenshots. Return all distinct places mentioned in the text.
>
> For each place return:
> - `name`: the proper name of the venue (e.g. "Maru Tonkatsu", "Tsukiji Outer Market"). Not generic categories ("a ramen shop"). Not descriptions ("the place near the station").
> - `city`: the city the place is in. Infer from context if possible (neighborhood names, country names, surrounding text). Empty string if truly ambiguous — never guess wildly.
> - `category`: `food` for restaurants / cafés / bars / markets. `activity` for things to do (hikes, museums, viewpoints, tours, day-trips). `place` for everything else (hotels, neighborhoods, generic locations).
>
> If the text has no travel places, return `{"places": []}`. This includes memes, screenshots of conversations, app UI, recipes without a venue, generic inspirational quotes, and travel imagery without a named place. Empty array is the correct answer for noise — do not invent.
>
> Do not return places that are not clearly named in the text.

The prompt will be tuned during the spot-check pass against ~50 real screenshots (see Testing). The spec commits to the shape.

**Rate limiting (Cloudflare Rate Limiting binding):**

```toml
# wrangler.toml
[[unsafe.bindings]]
name = "RATE_LIMIT"
type = "ratelimit"
namespace_id = "1001"
simple = { limit = 100, period = 60 }   # 100 req/min per key
```

```ts
const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
const { success } = await env.RATE_LIMIT.limit({ key: ip });
if (!success) return new Response(JSON.stringify({ error: "rate-limited" }),
  { status: 429, headers: { "content-type": "application/json" } });
```

Cheap insurance. A leaked URL costs only a few dollars to abuse before the limiter cuts in. The client (extraction module) treats 429 as retryable with exponential backoff.

**Logging.** The Worker writes request count, status code, and Gemini latency to Workers Logs. **It never logs the OCR text or the Gemini response body** — privacy posture. On error, the Worker logs the error class only (e.g. `gemini_5xx`, `parse_failure`, `rate_limit`). Debugging bad extractions is done locally on the dev's own screenshots; production debug-by-replay is intentionally out of scope.

**Secrets.** `GEMINI_API_KEY` is a Worker secret, set via `wrangler secret put`.

**Deploy:** `wrangler deploy`. Single environment, single URL — no staging during v0.2 (solo dev iteration). The proxy URL is committed in app config (`app.config.ts` extras) so the device knows where to call.

**Cost ceiling for the Worker itself** (Gemini cost is the line item that matters):
- Workers compute: free up to 100k req/day.
- Rate Limiting binding: free.
- Gemini: ~$6/mo at 45k calls (per the post-refresh budget table).

### Gemini API tier

**v0.2 (solo dev testing):** Free tier. Limits at the time of writing are roughly 15 RPM / 1500 RPD on Flash-Lite — comfortably above solo-dev volume (~3-5 calls/day). Free-tier requests **may be used by Google to improve their models**.

**v0.3 (TestFlight friends):** Switch to paid tier before sharing. ~10 friends × 3/day × 30 days = ~900/month — well within paid-tier rate limits, costs ~$0.20/month. The privacy disclosure copy in v1.0 reflects the paid-tier "data not used for training" posture.

The switch is a single config change (the API key) — no app or proxy code changes needed.

### `modules/extraction/` — new TS module

Mirrors `modules/processing` exactly in shape. Public surface:

```ts
export type ExtractionRunner = (ocrText: string) => Promise<ExtractedPlace[]>;
export type GeocoderRunner = (name: string, city: string) => Promise<GeocodeResult | null>;

export type CreateExtractorOptions = {
  db: Database;
  extract: ExtractionRunner;     // proxy client
  geocode: GeocoderRunner;       // native AppleGeocoder
  ownerId: string;
};

export function createExtractor(opts: CreateExtractorOptions): Extractor;
export function provideExtractor(e: Extractor): void;
export function getExtractor(): Extractor | null;

export interface Extractor {
  enqueueExtraction(screenshotId: string): void;
  runExtractionSweep(): Promise<void>;
  runStartupRecovery(): Promise<void>;
}
```

**Internals (mirror OCR):**

- Module-level singleton serial queue: `let chain: Promise<void> = Promise.resolve();` plus a `Set<string>` for dedup.
- `enqueueExtraction(id)` is a no-op if `id` is already in the set; otherwise appends `() => processOne(id).finally(() => set.delete(id))`.
- Retry counter: `Map<string, number>`, reset per process. 3 in-memory retries; on exhaustion `extraction_status='failed'`.
- `runExtractionSweep` queries:
  ```sql
  SELECT id FROM screenshots
   WHERE extraction_status = 'pending'
     AND ocr_status = 'done'
     AND deleted_at IS NULL
   ORDER BY captured_at ASC;
  ```
  …and `enqueueExtraction`s each. Mid-session sweeps **do not** re-process `failed` rows (same posture as OCR sweep).
- `runStartupRecovery` once per launch:
  ```sql
  UPDATE screenshots
     SET extraction_status = 'pending'
   WHERE extraction_status = 'failed' AND deleted_at IS NULL;
  ```
  Same "fresh 3-try budget per launch" semantics as OCR.

**`processOne(id)` flow:**

1. Load row: `SELECT id, ocr_text FROM screenshots WHERE id = ? AND deleted_at IS NULL`. If gone (concurrent delete), abort — no write.
2. **Empty / whitespace-only `ocr_text`** → short-circuit: `UPDATE screenshots SET extraction_status='done'`, no proxy call. This is the "noise" path: 0 places persisted, classifier signal recorded.
3. Call `extract(ocr_text)` (the proxy). Bubble errors out for retry policy to catch.
4. **Dedup the model output.** Apply a per-call dedup on the returned places, keyed by `(LOWER(name), LOWER(trim(city)))`. LLMs occasionally repeat the same place even when the prompt asks for distinct results; dropping repeats here keeps `place_count` honest, prevents the screenshot detail from showing duplicate rows, and prevents the trip-Places `source_count` from over-counting a single screenshot.
5. For each surviving place, call `geocode(name, city)` sequentially. Geocoding failure (`null` or thrown) → still keep the place; lat/lng/address/mapsUrl stay NULL.
6. Single transaction:
   ```sql
   BEGIN;
   INSERT INTO extracted_places (id, screenshot_id, name, city, category,
       latitude, longitude, formatted_address, apple_maps_url,
       extraction_model, owner_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
     -- repeat per place
   UPDATE screenshots SET extraction_status='done', updated_at=? WHERE id=?;
   COMMIT;
   ```
7. `notifyChange('extracted_places')`; `notifyChange('screenshots')` (so list queries with `place_count` re-fire).

**Retry classification** (in the proxy adapter, not in `processOne`):

| Proxy response | Treated as |
|---|---|
| 2xx | success |
| 429 | **deferred — does NOT consume 3-try budget.** Honor `Retry-After` header if present (clamped to a 5-minute ceiling); else default 60s. The row is re-enqueued at the back of the queue after the delay. The retry counter does not increment. |
| 5xx | retryable (consumes 3-try budget; backoff 1s/4s/16s) |
| 4xx (other) | permanent failure (immediate `failed`) |
| Network timeout (10s default) | retryable (consumes budget) |
| TLS / DNS error | retryable (consumes budget) |

`processOne` sees three outcomes: "success", "deferred — re-enqueue after delay" (429), or "throw — retry policy applies" (5xx / timeout / 4xx). The classifier of what's retryable / deferred lives in the adapter so it can be unit-tested in isolation.

**Why 429 is special.** Gemini free tier is 15 RPM. With the serial queue and a burst of 20 imports, the 16th request hits 429. A 1s/4s/16s backoff stays inside the same 60s window, so the row would otherwise be marked `failed` despite being recoverable seconds later. Treating 429 as a non-budget-consuming deferral keeps healthy rows from being permanently failed by transient flow control. The 5-minute ceiling on `Retry-After` is defensive — Gemini shouldn't send anything that long, but a misbehaving upstream shouldn't be able to wedge a row in `pending` indefinitely either; if `Retry-After` exceeds the ceiling, the adapter treats the response like a 5xx (retryable, budget-consuming) instead.

**Confidence column.** The day-one schema has `extracted_places.confidence REAL` but Gemini doesn't return one and we don't synthesize one. Leave it NULL. The column stays in case a future model returns a value.

**`raw_text` column.** Same disposition — leave NULL. Originally intended for the OCR snippet that produced this place, but reliably extracting that from the LLM is its own headache and isn't needed for any v0.2 surface.

**`extraction_model` column.** Populate with the model identifier returned by the proxy (e.g. `gemini-2.5-flash-lite`). The proxy sticks this on the response as a top-level field, the client persists it. Future-proofing for the day we A/B two models.

Roughly 200-250 lines of TS in `modules/extraction/extraction.ts`, plus `__tests__/extraction.test.ts`. Follows `modules/processing/processing.ts`'s file shape.

### `native/AppleGeocoder/` — new Expo Module (Swift)

Single async export:

```ts
geocodePlace(name: string, city: string): Promise<GeocodeResult | null>;

type GeocodeResult = {
  latitude: number;
  longitude: number;
  formattedAddress: string;
  appleMapsUrl: string;   // `https://maps.apple.com/?ll=…,…&q=…`
};
```

Implementation notes:

- `MKLocalSearch.Request` with `naturalLanguageQuery = "<name>, <city>"` (or just `name` if `city` is empty).
- Take the first `MKMapItem` from the response. Empty results → `null`.
- `formattedAddress` is the joined `placemark.postalAddress` lines.
- `appleMapsUrl` constructed from `placemark.coordinate` + name. We don't use `MKMapItem.url` (it's an `?addr=` deep link, not the public-share format).
- Vision-OCR-style serial queue: a private `DispatchQueue` so two requests can't race. (Apple's documented per-app rate limit is ~50/sec — well above our needs, but defensive.)
- 5-second timeout. On timeout, return `null` (not throw — geocoding is best-effort).
- Throws only on programmer error (empty name input). Network errors, "no results", and timeouts all yield `null`.

Roughly 80-120 lines of Swift. Follows `native/VisionOCR/` patterns. Same EAS / Pods / config-plugin story.

### Migration `0003_extraction.ts` — new

Adds the four geocoding columns to the existing `extracted_places` table:

```sql
ALTER TABLE extracted_places ADD COLUMN latitude REAL;
ALTER TABLE extracted_places ADD COLUMN longitude REAL;
ALTER TABLE extracted_places ADD COLUMN formatted_address TEXT;
ALTER TABLE extracted_places ADD COLUMN apple_maps_url TEXT;

CREATE INDEX IF NOT EXISTS idx_extracted_places_screenshot
  ON extracted_places(screenshot_id) WHERE deleted_at IS NULL;
```

`ALTER TABLE … ADD COLUMN` is fast and online — no table rebuild. Existing rows (none yet on any device, but any future shape change is forward-compatible) get NULL for the new columns.

**No FTS rebuild here.** OCR text already contains place names in the common case, so FTS-on-`ocr_text` already finds "Maru Tonkatsu". The inferred-city case (place's `city` doesn't appear in OCR) is real but small enough to defer. Folding extracted place names + cities into the FTS document is a later spec.

**No CASCADE on `screenshot_id`.** The day-one schema declares `FOREIGN KEY (screenshot_id) REFERENCES screenshots(id)` without `ON DELETE CASCADE`. Trip Pocket uses soft-delete (`deleted_at` timestamp) for screenshots, so cascade behavior on hard-delete isn't relevant in practice; queries unconditionally filter `WHERE s.deleted_at IS NULL`. Hard-deletes only happen in test cleanup, which today doesn't rely on cascade either.

### `modules/processing/processing.ts` — modify

In the OCR `processOne`'s success path (after the `UPDATE … ocr_status='done'` write), call `getExtractor()?.enqueueExtraction(id)`. Non-blocking; mirrors how `importImage` calls `getProcessor()?.enqueueOcr`. No-op when no extractor is provisioned (Jest tests, share extension, etc.).

This is the only change to the OCR module.

### `app/_layout.tsx` — modify

After the OCR processor is provisioned, also provision the extractor:

```ts
import { createExtractor, provideExtractor } from '@/modules/extraction';
import { extractFromProxy } from '@/modules/extraction/proxy';
import { geocodePlace } from '@/modules/apple-geocoder';

const extractor = createExtractor({
  db,
  extract: extractFromProxy,
  geocode: geocodePlace,
  ownerId,
});
provideExtractor(extractor);
await extractor.runStartupRecovery();
```

Then in the foreground-active effect, alongside `runOcrSweep()`:

```ts
await ctx.processor.runOcrSweep();
await ctx.extractor.runExtractionSweep();
```

`runStartupRecovery` for both runs once at boot; sweeps run on every foreground transition.

### Per-screenshot pin badge

The Inbox grid query (`modules/storage/screenshots.ts`) widens to:

```sql
SELECT s.id, s.file_path, s.ocr_status, s.extraction_status,
       COALESCE(p.place_count, 0) AS place_count
  FROM screenshots s
  LEFT JOIN (
    SELECT screenshot_id, COUNT(*) AS place_count
      FROM extracted_places
     WHERE deleted_at IS NULL
     GROUP BY screenshot_id
  ) p ON p.screenshot_id = s.id
 WHERE s.deleted_at IS NULL
   AND s.trip_id IS NULL                 -- inbox only
 ORDER BY s.captured_at DESC;
```

Same shape for the trip-detail grid (`WHERE s.trip_id = ?`). The pin overlay component (a tiny `MapPin` icon in the bottom-right of the thumbnail) renders when `place_count > 0`.

**Shimmer extends across the full background pipeline.** Today's OCR-only shimmer becomes the "still processing this" affordance for both phases. The condition:

```ts
const shimmer =
  ocr_status === 'pending' ||
  (ocr_status === 'done' && extraction_status === 'pending');
```

Read as: shimmer when the pipeline still has live work to do for this row. OCR-pending counts (OCR will run); OCR-done-and-extraction-pending counts (extraction will run); OCR-failed does NOT count even though `extraction_status` is still at its default `'pending'` (extraction's sweep requires `ocr_status='done'`, so it'll never reach this row this session — shimmer would be a lie). There's no visual distinction between the OCR phase and the extraction phase; the user shouldn't have to care which step we're on. On the live transition from extraction-pending → done-with-places, the shimmer disappears and the pin badge appears in the same `useLiveQuery` re-fire (the SQLite COMMIT is atomic).

Trade-off acknowledged: a screenshot whose OCR completed but whose extraction `failed` will show no shimmer and no pin badge — visually identical to a screenshot whose extraction completed with 0 places. That's the same posture as ARCHITECTURE.md's "OCR failures: silent in UI", extended consistently. Sentry will surface real failures in v0.3.

### Per-screenshot detail — Places section + "No places" annotation in `app/places/[id].tsx`

Below the existing image and OCR-text panel, render one of three blocks based on extraction state:

- `extraction_status='done'`, ≥1 places → a "Places" section listing them (see below).
- `extraction_status='done'`, 0 places → a single line: **"No places detected."** Footnote weight, system-gray. No CTA; the screen already has a delete affordance.
- `extraction_status` ∈ {`pending`, `failed`} → render nothing in the section's slot.

The "Places" section iff the screenshot has ≥1 extracted place:

```
Places
─────────────
🍜 Maru Tonkatsu              →
   Tokyo · Shibuya, …
─────────────
🍜 Tsukiji Outer Market       →
   Tokyo
```

Query:

```sql
SELECT id, name, city, category, formatted_address, apple_maps_url
  FROM extracted_places
 WHERE screenshot_id = ? AND deleted_at IS NULL
 ORDER BY created_at ASC;
```

Tap row → `Linking.openURL(apple_maps_url || queryFallback(name, city))`.

`queryFallback`: `https://maps.apple.com/?q=${encodeURIComponent([name, city].filter(Boolean).join(', '))}`.

**Category icon mapping** (single source of truth in `app/_components/CategoryIcon.tsx`):
- `food` → SF Symbol `fork.knife`
- `activity` → SF Symbol `figure.walk`
- `place` → SF Symbol `mappin.circle`

### Per-trip "Places" tab in `app/trips/[id].tsx`

Convert the trip detail screen's body from "grid only" to a tab toggle: **Photos** (default, existing grid) | **Places**.

Tab implementation: simple segmented control at the top of the body (matches iOS HIG; `SegmentedControlIOS` or a NativeWind-styled `View`+`Pressable` pair). State lives in the screen, not the URL — back-gesture restores the grid, not the previous tab.

Places tab query:

```sql
SELECT
  MIN(ep.id) AS id,
  ep.name,
  ep.city,
  ep.category,
  -- Within a group, all rows share the same maps_url (it's part of the key);
  -- MAX picks the formatted_address from the same canonical row.
  MAX(ep.formatted_address) AS formatted_address,
  ep.apple_maps_url,
  COUNT(DISTINCT ep.screenshot_id) AS source_count,
  MAX(ep.created_at) AS last_seen
FROM extracted_places ep
JOIN screenshots s ON s.id = ep.screenshot_id
WHERE s.trip_id = ?
  AND s.deleted_at IS NULL
  AND ep.deleted_at IS NULL
GROUP BY LOWER(ep.name), LOWER(TRIM(ep.city)), COALESCE(ep.apple_maps_url, '')
ORDER BY last_seen DESC;
```

Each row: category icon, name (primary text), city + "from N screenshots" (secondary text, only show count when >1). Tap → `Linking.openURL(apple_maps_url || queryFallback(name, city))`.

**Why `apple_maps_url` is part of the GROUP BY key.** Without it, two distinct branches of the same chain in the same city collapse into one row (e.g. two different Starbucks in Tokyo become a single row with `source_count=2`, and tapping it opens an arbitrary one of the two — the other is lost). With `apple_maps_url` in the key, geocoded distinct branches stay distinct (their URLs differ), while non-geocoded duplicates of the same name+city still merge (both have NULL → `COALESCE → ''` → same group, which is the correct outcome when we have no location signal). `TRIM(city)` guards against whitespace drift in LLM output (`"Tokyo "` vs `"Tokyo"`).

Empty state: "No places yet. Places extracted from your screenshots will appear here."

### `modules/extraction/proxy.ts` — proxy client

Single function that the extractor depends on as the `ExtractionRunner`. Reads the proxy URL from `Constants.expoConfig.extra.extractionProxyUrl`. Posts JSON, parses JSON, validates with Zod, returns `ExtractedPlace[]`.

Error mapping in the adapter (so `processOne` only deals with three outcomes: success, deferred-with-delay, or throw-and-apply-retry-policy):

```ts
type ExtractionErrorKind =
  | { kind: 'permanent' }                       // 4xx (non-429) — immediate `failed`
  | { kind: 'retryable' }                       // 5xx, timeout, TLS — counts toward 3-try budget
  | { kind: 'deferred'; retryAfterMs: number }; // 429 — re-enqueue, do NOT count

class ExtractionError extends Error {
  constructor(message: string, public readonly classification: ExtractionErrorKind) {
    super(message);
  }
}
```

`processOne`'s catch block branches on `err.classification.kind`:
- `permanent` → mark `failed` immediately.
- `retryable` → increment counter; re-enqueue if `<3`, else `failed`.
- `deferred` → `setTimeout(() => enqueueExtraction(id), retryAfterMs)`. Counter untouched. The dedup set is freed when the timer fires (so a second enqueue from a foreground sweep during the wait window doesn't create a parallel timer).

## Data flow

### Lifecycle of a single screenshot's extraction

```
OCR done ──▶ processor.processOne success path
                     │
                     │ getExtractor()?.enqueueExtraction(id)
                     ▼
              extractor queue (serial)
                     │
                     ▼ (when chain reaches it)
              load row, ocr_text empty? ──yes──▶ UPDATE extraction_status='done'
                     │ no
                     ▼
              fetch(POST /extract, { ocr_text })
                     │
                ┌────┴─────────────────────────────────────────────┐
                │                                                  │
              success                                            error
                │                                                  │
                ▼                                                  ▼
           for each place:                              retryable? ──── no ────▶ extraction_status='failed'
             AppleGeocoder.search                           │ yes
             → {lat,lng,addr,url} | null                    │
                │                                           ▼
                ▼                                    retryCount++ ; if <3 re-enqueue ; else failed
           BEGIN;
             INSERT extracted_places × N
             UPDATE screenshots
               SET extraction_status='done'
           COMMIT;
                │
                ▼
           notifyChange('extracted_places', 'screenshots')
```

### Triggers vs. paths in the queue

- **OCR-success path.** `processor.processOne` chains into `getExtractor()?.enqueueExtraction(id)`. Most extractions take this path.
- **Startup recovery.** `extractor.runStartupRecovery()` flips `failed → pending` once at boot. Any newly-pending row waits for the foreground sweep (next bullet) to actually be enqueued — startup recovery only un-fails, it doesn't enqueue.
- **Foreground sweep.** Catches:
  - Items left `pending` because the app died mid-extraction.
  - Items just promoted from `failed` to `pending` by startup recovery earlier in the same launch.
  - Items where OCR completed in a prior session but the OCR-success chain ran while the app was in the background and got dropped (paranoia path; the OCR pipeline already runs `runOcrSweep` on foreground, so any newly-OCR-done row will be sweep-pickable for extraction within the same active period).

The queue dedupes on `screenshotId`, so the OCR-success path and the sweep path can't cause double work.

## State & retry policy

| State | Semantics | Transitions |
|---|---|---|
| `pending` | Not yet attempted, or attempt in flight, or deferred after a 429, or just promoted from `failed` by startup recovery. | → `done` on success (incl. empty-OCR short-circuit). → `failed` after 3 in-memory retries within the current app session (429 deferrals are NOT counted). |
| `done` | Extraction complete. 0..N rows in `extracted_places`. The 0-row case IS the classifier's "noise" signal. | Terminal in v0.2 (no re-extraction). |
| `failed` | 3 in-session retries exhausted. | → `pending` on next process start (via `runStartupRecovery`), once. Mid-session foreground sweeps **do not** re-pick `failed`. |

3 in-memory retries reuses the OCR pipeline's number — same defensible default. Once-per-launch promotion of `failed → pending` is intentional: a screenshot that genuinely can't be extracted (e.g. proxy is down for hours) doesn't burn budget on every foreground in between, but does get re-tried on the next cold start.

## UI states

| Surface | State | Behavior |
|---|---|---|
| Inbox / Trip detail thumbnail | shimmer condition true (see above) | Shimmer (`animate-pulse` + `bg-black/10`). Single affordance for both background phases — no visual distinction between OCR-pending and extraction-pending. |
| Inbox / Trip detail thumbnail | `extraction_status='done'`, `place_count > 0` | **Pin badge** (bottom-right corner): SF Symbol `mappin.circle.fill`, system-blue, full opacity. On extraction commit, the shimmer-off and pin-on transitions are atomic. |
| Inbox / Trip detail thumbnail | `extraction_status='done'`, `place_count == 0` | **"No places" badge** (bottom-right corner): SF Symbol `mappin.slash`, system-gray, ~60% opacity. Tells the user "we processed this and didn't find anything to save" so they can confidently delete. Visually subordinate to the positive pin badge. |
| Inbox / Trip detail thumbnail | `ocr_status='failed'` OR `extraction_status='failed'` | No badge, no shimmer. Failure is silent — the row may still produce places after a process restart (`runStartupRecovery`), so showing "no places" would be a false signal. Same posture as ARCHITECTURE.md's OCR rule. |
| Screenshot detail | `extraction_status='done'`, ≥1 places | "Places" section renders below image + OCR panel. |
| Screenshot detail | `extraction_status='done'`, 0 places | Small annotation below the OCR panel: "No places detected." Subtle (system-gray, footnote weight). No CTA — the existing detail-screen delete affordance is what the user uses. |
| Screenshot detail | `extraction_status='pending'` | No "Places" section yet, no annotation. The thumbnail-grid shimmer is the only "still working" cue; the detail screen doesn't get its own. |
| Screenshot detail | `extraction_status='failed'` | No "Places" section, no annotation. Silent. |
| Trip detail | trip has any extracted places | Tab toggle visible: Photos / Places. |
| Trip detail | trip has 0 extracted places | Tab toggle hidden (just the Photos grid as today). Avoids an empty Places tab dangling at the top of every brand-new trip. |
| Trip detail | tab toggle visible, Places tab tapped | Distinct-place list, ordered by last-seen DESC. |

Extraction failures are silent (same posture as OCR failures, per ARCHITECTURE.md's "OCR failures: silent in UI" — extending the rule to extraction).

## Failure modes

| Case | Behavior |
|---|---|
| Proxy 5xx | Retry per policy. After 3, `failed`. |
| Proxy 429 | Defer (re-enqueue at back of queue) after `Retry-After` (default 60s, max 5min). **Does not consume the 3-try budget** — flow control isn't a per-row failure. |
| Proxy 4xx (other) | Mark `failed` immediately. No retry. |
| Network timeout (10s default) | Retry per policy. |
| Gemini returns malformed JSON | Worker returns 502. Client retries. (Should be ~impossible with `responseSchema`, but defended.) |
| Empty / whitespace-only OCR text | Short-circuit — `extraction_status='done'`, 0 places. No proxy call. |
| OCR text > some-large-threshold | Truncate to ~10000 chars in the client before posting. Realistic OCR is far below this; the cap exists so a pathological screenshot doesn't blow the input-token budget. |
| Geocoding returns null (place not found) | Persist place with NULL lat/lng/address. Tap-to-Maps falls back to `?q=` query string. |
| Geocoding throws | Same as null — swallow, persist place without geocode, log `geocode_error` class. |
| Screenshot soft-deleted mid-extraction | `processOne` re-checks the row at start; if `deleted_at` is set, abort writes. If deletion happens between the load and the INSERT, the INSERT still succeeds (queries filter on `s.deleted_at IS NULL` so the orphan place rows are invisible — best-effort cleanup deferred). |
| Screenshot hard-deleted mid-extraction | INSERT fails on FK constraint. Caught and treated as a permanent failure (no retry). |
| User force-quits the app during a Gemini call | The fetch is dropped; no DB write happens. Row stays `pending`. Next foreground sweep re-enqueues. |
| Two extractions enqueued for same id | Dedup via in-memory `Set<string>`. One proxy call. |
| Free-tier rate limit (15 RPM) hit | Proxy returns the upstream Gemini 429 with `Retry-After`. Client defers the row (no budget consumed) and re-enqueues after the delay. A burst of 20 imports drains in two waves ~60s apart. |
| Worker hits Cloudflare's per-IP rate-limit binding | Proxy returns 429 with `Retry-After: 60`. Same deferred behavior. |

## Privacy / disclosure posture

- **Today (v0.2 dev only):** OCR text leaves the device en route to the Worker, then to Gemini. Only the dev's own screenshots are exposed. Free tier means Google may use the text to train models — acceptable for solo testing.
- **v0.3 TestFlight:** switch to paid Gemini tier (no training). Disclosure copy added in onboarding for friends ("Trip Pocket sends extracted text to a server to identify places. Images stay on your device.").
- **v1.0:** add proxy auth (RevenueCat-gated), keep paid tier.

The Worker never persists request bodies. Workers Logs gets only metadata (status, latency, error class). Image files never leave the device — only the OCR-extracted text does.

## Open questions / decisions made

Resolved:

| Question | Decision |
|---|---|
| Output shape | Multi-place: `{ name, city, category }` per place. `category ∈ {place, food, activity}`. |
| Maps strategy | Apple Maps only. Geocoded deep link when MKLocalSearch hits; `?q=` query-string fallback otherwise. |
| Geocoder | Apple `MKLocalSearch`, on-device, post-extraction. |
| Model | Gemini 2.5 Flash-Lite. `responseSchema` for strict JSON. Free tier for v0.2; paid before v0.3. |
| Proxy host | Cloudflare Worker. Free at our scale. |
| Proxy rate-limit | Cloudflare Rate Limiting binding (not KV). 100 req/min per IP. |
| Proxy logging | Status + latency + error class. **Never** OCR text or response bodies. |
| Retry policy | Mirrors OCR for 5xx/timeout/network: 3 in-memory retries, `failed → pending` once per launch. **429 is deferred, not retried** — re-enqueued after `Retry-After` (default 60s, max 5min) without consuming the retry budget. |
| Per-call dedup | Before the INSERT transaction, dedup model output on `(LOWER(name), LOWER(TRIM(city)))`. Defends against LLM list-mode repeating itself. |
| Trip-Places dedup key | `GROUP BY LOWER(name), LOWER(TRIM(city)), COALESCE(apple_maps_url, '')`. Distinct branches with distinct geocoded URLs stay distinct; non-geocoded duplicates merge. |
| Empty-OCR handling | Short-circuit to `extraction_status='done'` with 0 places. No proxy call. |
| Classifier-driven hiding (Inbox) | **Not** in v0.2. Manual imports remain visible regardless of place count. Auto-detect (next spec) is the consumer of the 0-place signal. |
| Places-tab dedup | `GROUP BY LOWER(name), LOWER(city)`. |
| Per-screenshot badge | Three states: pin (`place_count > 0`, system-blue full-opacity), "no places" (`extraction_status='done' AND place_count == 0`, system-gray ~60% opacity), or none (any `failed` or shimmer-active). |
| Pending indicator | Existing OCR shimmer extends to extraction. Render shimmer when `ocr_status='pending' OR (ocr_status='done' AND extraction_status='pending')`. Failures silent. One visual, both phases. |
| 0-places posture | NOT silent. Show a "no places" badge on the thumbnail and a "No places detected." annotation in the detail screen so users can spot junk and clean it up. Failures stay silent (could be transient). |
| FTS expansion | Out of scope. OCR text already covers the common case; inferred-city search is a later spec. |
| Re-extraction | Out of scope. `done` is terminal in v0.2. |

Deferred to later specs:

- Auto-detect (next spec; consumes the 0-place classifier signal).
- Manual editing or deletion of extracted places.
- Google Maps deep-link variant.
- In-app map view of saved places (v1.x).
- FTS document expansion to include extracted name + city.
- Sentry / `telemetry.captureError` wiring for extraction failures (lands with v0.3 telemetry).

## Testing

**Unit tests (Jest, `modules/extraction/__tests__/extraction.test.ts`):**

- `processOne` happy path: stubbed proxy returns 2 places, stubbed geocoder returns coords for one and null for the other → assert 2 inserts (one with full geocode, one with NULLs), `extraction_status='done'`, `notifyChange` fired for both tables.
- Empty OCR: `processOne` skips the proxy call entirely, writes `done` with 0 places, geocoder never called.
- Proxy 5xx: stub throws retryable `ExtractionError(retryable=true)` 3× → assert 3rd flips to `failed`, in-memory counter at 3.
- Proxy 4xx: stub throws `ExtractionError(retryable=false)` → immediate `failed`, no retries.
- Proxy 429 deferral: stub throws `ExtractionError(deferred=true, retryAfterMs=60000)` → assert row stays `pending`, retry counter does NOT increment, re-enqueue scheduled at the back of the queue after `retryAfterMs`. Even after 5 such deferrals, status stays `pending` (regression guard for the codex-flagged 429-burst bug).
- 429 with missing `Retry-After`: defaults to 60s.
- 429 with `Retry-After` exceeding 5-minute ceiling: treated as 5xx (consumes budget) — defensive cap.
- Per-call dedup: stub proxy returns `[{name:'X',city:'Y'},{name:'x',city:'Y '},{name:'Z',city:'W'}]` → assert only 2 INSERTs (`X,Y` and `Z,W`) — case-insensitive name + trimmed city.

**Component test (`app/_components/__tests__/ScreenshotThumbnail.test.tsx`):**

- `ocr_status='pending'`, `extraction_status='pending'` → shimmer, no badge.
- `ocr_status='done'`, `extraction_status='pending'` → shimmer, no badge (the merged condition).
- `ocr_status='done'`, `extraction_status='done'`, `place_count=0` → no shimmer, **NoPlacesBadge** rendered.
- `ocr_status='done'`, `extraction_status='done'`, `place_count=2` → no shimmer, **PinBadge** rendered.
- `ocr_status='failed'`, `extraction_status='pending'` → no shimmer, no badge. Regression guard against a `failed` row shimmering forever.
- `ocr_status='done'`, `extraction_status='failed'` → no shimmer, no badge. The 0-places "no places" badge does NOT render here — failure could be transient (recoverable on next launch).
- Pin and NoPlaces badges are mutually exclusive — never both at once.
- Queue dedup: two concurrent `enqueueExtraction(id)` → one proxy call.
- Queue serialization: enqueue idA then idB with delayed proxy stub → idA completes before idB starts.
- Soft-deleted mid-flight: `processOne` re-checks row, aborts if `deleted_at` set, no inserts.
- `runExtractionSweep` picks only `extraction_status='pending' AND ocr_status='done'`, ordered by `captured_at ASC`, doesn't re-pick `failed`.
- `runStartupRecovery` flips `failed → pending` and is a no-op on subsequent same-process calls.

**Adapter unit tests (`modules/extraction/__tests__/proxy.test.ts`):**

- 200 with valid body → returns parsed places.
- 200 with malformed body (Zod fail) → throws `ExtractionError(retryable=true)`.
- 4xx (non-429) → throws `ExtractionError(retryable=false)`.
- 429 with `Retry-After: 30` → throws `ExtractionError(deferred=true, retryAfterMs=30000)`.
- 429 with no `Retry-After` → throws `ExtractionError(deferred=true, retryAfterMs=60000)` (default).
- 429 with `Retry-After: 600` (>5min) → throws `ExtractionError(retryable=true)` (treated like 5xx).
- 5xx → throws `ExtractionError(retryable=true)`.
- Network timeout (mocked AbortError) → throws `ExtractionError(retryable=true)`.

**Storage tests (`modules/storage/__tests__/migrations.test.ts`):**

- Migration `0003_extraction.ts` applies cleanly on a fresh DB and on a v0.2-OCR DB.
- Post-migration: `latitude`, `longitude`, `formatted_address`, `apple_maps_url` exist on `extracted_places`.
- Insert into `extracted_places` after migration succeeds with all-NULL geocoding columns.

**Worker tests (`workers/extract-proxy/`, Vitest with `@cloudflare/vitest-pool-workers`):**

- POST /extract with valid OCR → 200, valid `{places:[…]}`, Gemini stub called once.
- POST /extract over rate limit → 429.
- Stubbed Gemini 5xx → 502.
- Stubbed Gemini malformed JSON → 502.
- Empty body → 400.
- Wrong content-type → 400.
- The Gemini stub is a `fetch` interceptor; we don't hit Google.

**Native module — manual smoke test on device:**

- `geocodePlace('Maru Tonkatsu', 'Tokyo')` returns a non-null result with sensible coords + an Apple Maps URL.
- `geocodePlace('Asdf qwer', 'Zzzland')` returns null.
- 50-screenshot accuracy spot-check before committing the prompt: pull 50 real travel screenshots from camera roll, run extraction, eyeball results. Acceptance bar: ≥40/50 produce sensible `(name, city, category)` triples. Tune the prompt or escalate model choice if below.

**E2E:** out of scope (Maestro deferred per ARCHITECTURE.md).

## File-change inventory

**New:**

- `workers/extract-proxy/` — Cloudflare Worker (src/index.ts, src/prompt.ts, src/schema.ts, wrangler.toml, package.json, tsconfig.json, README.md).
- `native/AppleGeocoder/` — Swift Expo Module (Package.swift, expo-module.config.json, Sources/AppleGeocoderModule.swift, ios/AppleGeocoder.podspec, etc.).
- `plugins/with-apple-geocoder.js` — config plugin if Info.plist tweaks are needed (TBD at plan time).
- `modules/extraction/index.ts`, `modules/extraction/extraction.ts`, `modules/extraction/proxy.ts`, `modules/extraction/__tests__/extraction.test.ts`, `modules/extraction/__tests__/proxy.test.ts`.
- `modules/apple-geocoder/index.ts` — TS wrapper around the native module (mirrors `modules/vision-ocr/`).
- `modules/storage/migrations/0003_extraction.ts`.
- `app/_components/CategoryIcon.tsx` — single-source-of-truth icon mapping for `place|food|activity`.
- `app/_components/PinBadge.tsx` — positive-state badge (place_count > 0).
- `app/_components/NoPlacesBadge.tsx` — neutral-state badge (extraction done, 0 places). Two small focused components instead of one polymorphic one.
- `app/_components/PlaceStatusAnnotation.tsx` — the "No places detected." text in the screenshot detail screen.
- `app/_components/PlacesSection.tsx` — reusable places-list block (used in screenshot detail and trip detail places tab).

**Modified:**

- `modules/storage/migrations/index.ts` — register the new migration.
- `modules/storage/screenshots.ts` — list / detail queries widen to include `extraction_status` and `place_count` (LEFT JOIN). Both fields drive the thumbnail's combined shimmer + pin-badge logic.
- `app/_components/ScreenshotThumbnail.tsx` — extend the OCR shimmer condition to also fire on `extraction_status='pending'`. One-liner change to the existing component, but called out so the implementation plan owns it.
- `modules/processing/processing.ts` — call `getExtractor()?.enqueueExtraction(id)` in OCR success path.
- `app/_layout.tsx` — provision extractor; run startup recovery; add `runExtractionSweep` to the foreground-active effect.
- `app.config.ts` — add `extra.extractionProxyUrl`.
- `app/(tabs)/index.tsx` (Inbox) — render `PinBadge` overlay on thumbnails when `place_count > 0`.
- `app/trips/[id].tsx` — tab toggle (Photos | Places); render `PinBadge` on the grid; add Places tab content.
- `app/places/[id].tsx` (screenshot detail) — render `PlacesSection` below image/OCR panel when ≥1 places.

**Deleted:** none.

## Implementation order suggestion (for the plan)

1. **Migration** `0003_extraction.ts` (add columns + index). Smallest blast radius. Storage tests first.
2. **Native AppleGeocoder module** — skeleton + smoke on device. Own commit.
3. **Cloudflare Worker proxy** — deploy to a single env, smoke `curl`. Own commit (separate dir, doesn't touch the app).
4. **`modules/extraction`** — extractor + proxy adapter + tests, against stubbed proxy + stubbed geocoder. Unit-tested before any device wiring.
5. **Wire into OCR + `_layout`** — extractor provisioning + OCR-success chain + sweep + startup recovery. Smoke on device with 5-10 real screenshots; tune the system prompt against the 50-screenshot accuracy bar.
6. **Pin badge** — `PinBadge` component, screenshot list query widening, render in Inbox + trip detail grids.
7. **Per-screenshot Places section** — `PlacesSection` + `places/[id]` integration.
8. **Per-trip Places tab** — tab toggle + Places query + reuse `PlacesSection`.
9. **End-to-end smoke + prompt tune-up** before declaring v0.2 extraction done.

## Sequencing note

After this ships, the next v0.2 spec is **classifier-gated auto-detect**. It will:

- Watch for new screenshots via `PHPhotoLibrary` change observers.
- Auto-import them through the same `importImage` path → OCR → extraction.
- Use `extraction_status='done' AND place_count=0` as the **noise filter**: those auto-imported screenshots are recorded for dedup but stay hidden from Inbox. Only screenshots with `place_count >= 1` surface for review.
- Manual imports (share-sheet, camera-roll picker) continue to bypass the noise filter — user intent overrides the classifier.

After auto-detect, the remaining v0.2 items (manual tagging via `tags` table, trip-detail filtering by tag, performance pass) are independent and slot in alongside.
