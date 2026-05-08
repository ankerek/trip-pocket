# Place enrichment — design

**Status:** v0.2 scope, design locked. Sequenced after extraction.
**Driver:** "User can actually see what the place is — not just derive it from the screenshot."
**Date:** 2026-05-08 (originally drafted as a v1.x parking-lot item; promoted into v0.2 on 2026-05-08 alongside the auto-detect deferral.)

## Context

Today an extracted place is just a name, a city, an address (when present), and a category. To recognize a café you screenshotted three months ago, you have to re-open the original screenshot and read it. That defeats the wedge — *save it before it's lost* — because the saved-state is barely better than the camera roll it replaced.

Enrichment closes that gap: each place gets a real photo of the venue, a 1-2 sentence narrative, and structured metadata (rating, hours, price level). The place becomes a glanceable card.

## Decisions

| Decision | Choice | Reasoning |
|---|---|---|
| **Interim geocoding (extraction shipped, enrichment not yet)** | Skipped — `apple_maps_url` is a search-URL deep link with the full address | Apple's `CLGeocoder` / `MKLocalSearch` APIs are unreliable for non-English-script countries (Japanese addresses fail routinely). Investing in a server-side geocoder would be wasted work; enrichment provides geocoding as a free side-effect. The search-URL fallback is the bridge state during v0.2 between AI extraction landing and enrichment landing. |
| **Enrichment trigger** | On-demand, when the user opens a place card that hasn't been enriched | Travel-screenshot apps have heavy-save / light-browse usage. Most saved places are never viewed. On-demand pays only for engagement. ~500ms first-view loading state is acceptable; cached forever after. |
| **Premium gate** | None — enrichment is free for all users | Enrichment IS the value-prop "magic moment." Gating it would hurt the demo and word-of-mouth. Premium gates other things (cloud sync, unlimited trips). |
| **Data source — facts** | Google Places API (New) | Best worldwide coverage for the long tail of small/trendy venues that dominate Instagram travel content. Foursquare is ~70% of the cost but noticeably weaker in Asia. |
| **Data source — narrative** | Gemini (already wired through Cloudflare AI Gateway) | Google Places' `editorial_summary` field is sparse. Gemini synthesizes a 1-2 sentence blurb from Places' structured fields + the OCR caption. Costs ~$0.0005/place via flash-lite. |
| **Photo handling** | Worker-proxied: store the durable `photo_name` (the Places New resource ID), serve via `/photo/<name>` on our worker which fetches Google with the server-side key and pipes back. Edge-cached. | (a) The Places media URL embeds `?key=…`; returning it to clients leaks the server credential. (b) Only `photo.name` is durable — Google rotates the signed media URL, so persisting the URL means broken images on rotation. (c) Edge caching the proxy response amortizes Google's per-display photo billing to first-fetch-per-PoP. |
| **Schema** | Two tables: `extracted_places` gains a few per-row columns (`external_place_id`, `enrichment_status`, `enriched_at`); a new `place_enrichments` table holds the venue-level data keyed by `external_place_id`. | One-to-one on `extracted_places` would charge for enrichment N times when the same venue is saved across N screenshots — a real case in this app. Venue-keyed dedup makes "saved Kosoan three times" cost one enrichment. The grouped trip-Places UI also queries by venue; a shared row means siblings render enriched together. |
| **Map app preference** | Build the deep link at render time from stored data (`name`, `latitude`, `longitude`, `external_place_id`, `address`). Prefer Google Maps when installed; fall back to Apple Maps. No persisted `*_maps_url` column. | iOS has no system-level "default map app" setting an app can query, but `Linking.canOpenURL('comgooglemaps://')` is a reliable proxy — users who installed Google Maps overwhelmingly prefer it for navigation. Storing a hardcoded `apple_maps_url` was the wrong primitive: the right thing to persist is the place's identity, and the URL is a presentation concern. Also future-proofs us for an in-app setting / Android. |
| **Google Places API key** | Dedicated `GOOGLE_PLACES_API_KEY`, separate from `GOOGLE_GENAI_API_KEY` (Gemini). Restricted to the Places APIs and to the worker's outbound IP set (Cloudflare egress). | Two reasons to separate: (a) blast radius — the photo-proxy route embeds the key in its outbound fetch; if it ever leaks, only Places is exposed, not the Gemini account. (b) Different rotation cadence and billing isolation. The extra config cost is one extra Worker secret, which is free. |

## Architecture

Two new worker endpoints sit next to `/extract`:

```
POST https://trip-pocket-extract-proxy.<subdomain>.workers.dev/enrich
Body: {
  extracted_place_id,
  name,
  city,
  address,        // OCR-extracted street address, may be null
  ocr_caption     // full OCR text from the screenshot, used by step 3 below
}

GET  https://trip-pocket-extract-proxy.<subdomain>.workers.dev/photo/<photo_name>?w=<maxW>&h=<maxH>
```

`ocr_caption` is required. The worker is stateless; without the caption being in the request, the Gemini blurb step has no way to anchor the narrative to *what the user actually saw*. Capped at ~2 KB on the client; longer OCR is truncated.

Flow inside `/enrich`:

1. **Find Place from Text** (Google Places) — input: `"<name>, <address || city>"` → output: `place_id` + lat/lng + formatted_address.
2. **Place Details** (Google Places, `place_id`) — output: `photos[]` (each with a stable `name`), rating, price_level, types, opening_hours, website, url.
3. **Gemini blurb** — prompt: structured fields from step 2 + the OCR caption from the request. Output: a 1-2 sentence narrative.
4. **Merged response** to the app:

   ```json
   {
     "external_place_id": "ChIJ…",
     "latitude": 35.6076,
     "longitude": 139.6680,
     "formatted_address": "1 Chome-24-23 Jiyugaoka, Meguro City, Tokyo 152-0035, Japan",
     "photo_name": "places/ChIJ…/photos/AeJbb3…",
     "description": "Cozy 1950s tea house in residential Jiyugaoka, known for matcha and traditional sweets.",
     "rating": 4.5,
     "price_level": 2,
     "external_url": "https://maps.google.com/?cid=…",
     "model": "gemini-2.5-flash-lite"
   }
   ```

Note: `photo_name` (not a URL) is the durable identifier. The client builds the display URL by hitting the worker's `/photo/<photo_name>` route. **Never** persist the raw Google media URL — it embeds the API key and is not guaranteed stable across rotations.

The response intentionally does **not** include `apple_maps_url` or `google_maps_url`. Map deep links are presentation, not data — built at render time from the persisted identity fields (`name`, `latitude`, `longitude`, `external_place_id`, `address`). See "Client-side map link" below.

Flow inside `/photo/<photo_name>`:

1. Reject if `photo_name` doesn't match the `places/.../photos/...` shape (defense against open-redirect / SSRF).
2. Build `https://places.googleapis.com/v1/<photo_name>/media?maxWidthPx=<w>&maxHeightPx=<h>&key=<GOOGLE_PLACES_API_KEY>` and fetch. Note the dedicated key — separate from the Gemini key per the decisions table.
3. Stream the response body back to the client with `Content-Type` preserved and `Cache-Control: public, max-age=2592000, immutable` (30 days). Cloudflare's edge cache absorbs repeat hits at the PoP — Google billing only fires on cache misses.
4. Errors: `404` from Google → `404`; anything else → `502`. No retries (the client will re-request on next render anyway).

Error classification on `/enrich` mirrors `/extract`:
- 200 — success (or `"not-found"` body when Find Place returned zero matches).
- 4xx — permanent (bad input, no retry).
- 429 — rate-limited (worker rate limit binding).
- 5xx — retryable.

Both endpoints reuse the existing rate-limit binding (per-IP, 100 req/60s) and the existing AI Gateway routing for the Gemini step inside `/enrich`.

## Client-side map link

A small helper — `lib/openInMaps.ts` — picks the best deep link at tap time and hands it to `Linking.openURL`. The persisted state has no `*_maps_url` field; URLs are derived from `(name, latitude, longitude, external_place_id, address, city)`.

Algorithm:

1. **Detect:** call `Linking.canOpenURL('comgooglemaps://')`. Cache the result for the session (results don't change without an app install / uninstall).
2. **Pick:**
   - If Google Maps is installed → build `comgooglemaps://?q=<name>&center=<lat>,<lng>&zoom=15` when lat/lng are present, otherwise `comgooglemaps://?q=<name, address || city>`. If `external_place_id` is present, prefer the universal-link form `https://www.google.com/maps/search/?api=1&query=<name>&query_place_id=<external_place_id>` — Google Maps app intercepts this and pins the exact venue, no ambiguity.
   - Else → Apple Maps universal link: `https://maps.apple.com/?ll=<lat>,<lng>&q=<name>` when lat/lng are present, otherwise `https://maps.apple.com/?q=<name, address || city>`.
3. **Open:** `Linking.openURL(url)`.

The same helper applies pre- and post-enrichment — it just gets richer inputs (lat/lng + `external_place_id`) once enrichment lands. Pre-enrichment, callers pass `name + city + address` and the helper falls back to search-string deep links, identical to what `PlaceRow` does today against Apple Maps only.

This is also a small, non-blocking pre-enrichment improvement: today's hardcoded `https://maps.apple.com/?q=...` in `PlaceRow.tsx` should be replaced with this helper now, so users with Google Maps installed get their preferred app even before enrichment ships. (Implementation step 0 in the order below.)

Deferred (not in v0.2):
- An in-app setting to override the heuristic. Add when the heuristic produces complaints.
- A long-press chooser sheet ("Open in… Apple Maps / Google Maps / Copy address"). Worth doing in v0.3 polish if the heuristic surprises any users.
- Android (Google Maps native intent / `geo:` URI).

## Schema additions

A future migration introduces a venue-keyed `place_enrichments` table and adds three per-row tracking columns to `extracted_places`:

```sql
-- Per-venue enrichment data. One row per Google Places venue (`external_place_id`).
-- Multiple `extracted_places` rows can share one enrichment row when the user
-- saves the same venue across several screenshots.
CREATE TABLE place_enrichments (
  external_place_id  TEXT PRIMARY KEY,
  photo_name         TEXT,             -- Places New durable resource ID; URL is built at render time
  description        TEXT,             -- Gemini-synthesized 1-2 sentence blurb
  rating             REAL,
  price_level        INTEGER,
  external_url       TEXT,             -- Google Maps `cid=` URL if returned, useful for "View on Google Maps"
  latitude           REAL,
  longitude          REAL,
  formatted_address  TEXT,
  fetched_at         TEXT NOT NULL,
  model              TEXT NOT NULL     -- Gemini model id used for the blurb
);
-- Map deep links (Apple/Google) are intentionally not stored. They're built
-- at render time by lib/openInMaps.ts from (name, lat, lng, external_place_id,
-- address, city) so we can respect the user's installed map app.

-- Per-row enrichment state. Tracks the relationship between an extracted_places
-- row and the venue it resolves to (or, in 'not-found' / 'failed' states, the
-- attempt to resolve).
ALTER TABLE extracted_places ADD COLUMN external_place_id TEXT;
ALTER TABLE extracted_places ADD COLUMN enrichment_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE extracted_places ADD COLUMN enriched_at TEXT;

CREATE INDEX idx_extracted_places_external_place_id
  ON extracted_places(external_place_id);
```

`enrichment_status` values: `'pending' | 'enriched' | 'not-found' | 'failed'`.

The split serves two needs:

- **Venue dedup.** When a user has saved Kosoan in three screenshots, all three `extracted_places` rows resolve to the same `external_place_id` and share one `place_enrichments` row. The first enrichment costs $0.045; the next two are free. The grouped trip-Places UI also benefits — it queries one row per venue, not one per screenshot.
- **Per-row attempt tracking.** `enrichment_status = 'not-found'` and `'failed'` are properties of *the OCR row's attempt*, not of any venue, so they live on `extracted_places`. A row that's `'not-found'` for one user might be `'enriched'` for another whose OCR string was sharper.

Existing `extracted_places` columns:
- `latitude`, `longitude`, `formatted_address`, `apple_maps_url` — added by migration 0003 before this design committed to the venue-keyed split. Going forward they stay NULL on `extracted_places`; the venue-level lat/lng/formatted_address are read from `place_enrichments` via JOIN, and `apple_maps_url` is dead in two ways (wrong table *and* wrong primitive — replaced by `lib/openInMaps.ts`). Cleanup migration is deferred (SQLite `DROP COLUMN` is supported but unnecessary churn pre-launch).
- `address` — populated by Gemini at extraction time. Stays as the input to enrichment and as a `lib/openInMaps.ts` input.

## Client-side flow

When the user opens a place row whose `enrichment_status IN ('pending', 'failed')`:

1. Render the existing OCR-based card immediately (skeleton state with name + address + category icon).
2. **Pre-flight venue check.** If another `extracted_places` row already has a non-null `external_place_id` whose `(LOWER(name), LOWER(TRIM(city)), LOWER(TRIM(COALESCE(address, ''))))` key matches this row's, copy that `external_place_id` and set `enrichment_status = 'enriched'` without calling the worker. The shared `place_enrichments` row already has the data. This handles "user saved the same place three times" cheaply.
3. Otherwise, fire a background `POST /enrich` with `{ extracted_place_id, name, city, address, ocr_caption }`. The OCR caption is loaded from the source `screenshots` row.
4. On success: in one SQLite transaction, `INSERT OR IGNORE INTO place_enrichments` keyed on the returned `external_place_id` (IGNORE because a sibling row may have raced and inserted first), then `UPDATE extracted_places SET external_place_id = ?, enrichment_status = 'enriched', enriched_at = ? WHERE id = ?`. The live-query subscription re-renders the card with photo + description via JOIN.
5. **Sibling propagation.** Right after step 4, run `UPDATE extracted_places SET external_place_id = ?, enrichment_status = 'enriched', enriched_at = ? WHERE deleted_at IS NULL AND external_place_id IS NULL AND enrichment_status IN ('pending', 'failed') AND LOWER(name) = LOWER(?) AND LOWER(TRIM(city)) = LOWER(TRIM(?)) AND LOWER(TRIM(COALESCE(address, ''))) = LOWER(TRIM(COALESCE(?, '')))`. This back-fills siblings that match the OCR-key of the row we just resolved, so opening any of them later is a no-op.
6. On `'not-found'`: set `enrichment_status = 'not-found'`, no UI change. The card stays in OCR-only form. Don't retry on subsequent opens (the trigger condition excludes `'not-found'`).
7. On `'failed'`: set `enrichment_status = 'failed'`. Each subsequent open retries automatically because the trigger condition includes `'failed'` — no retry budget. Reasoning: the user re-opening a card is an explicit signal they want the data, and the worker's own rate-limit binding caps the blast radius.

In-flight dedup: a per-process `Map<string, Promise<EnrichResult>>` keyed on the OCR-key `name|city|address` (lowercased, trimmed). Multiple taps on the same row — or on different rows that resolve to the same venue — share a single in-flight `/enrich` call. After step 5 lands, sibling-row taps short-circuit at step 2 and never reach the dedup map.

## Forward-compatibility check (what carries forward, what doesn't)

The interim state (extraction shipped, enrichment not yet) skips geocoding and uses search-URL deep links. Three decisions, each largely forward-compatible:

- **Skip geocoding** — `extraction.ts` will not call any geocoder. `latitude`, `longitude`, `formatted_address`, `apple_maps_url` on `extracted_places` are all NULL when the row is inserted. Forward-compatible: enrichment fills those fields on the new `place_enrichments` row, joined at query time.
- **Map deep link** — handled by `lib/openInMaps.ts` (see "Client-side map link" above). The helper picks Google Maps vs. Apple Maps at tap time based on `Linking.canOpenURL('comgooglemaps://')`, and falls back to a search-string URL when lat/lng aren't available (i.e., pre-enrichment). The helper replaces today's hardcoded `https://maps.apple.com/?q=name, city` in `PlaceRow.tsx`. Forward-compatible: same helper, richer inputs after enrichment (lat/lng + `external_place_id` produce a pin instead of a search).
- **`address` column** — populated by Gemini at extraction time (already shipped); this is the input to enrichment. Forward-compatible.

**What does NOT carry forward unchanged:**

The current trip-detail Places query (`TRIP_PLACES_SQL` in `app/trips/[id].tsx`) groups by `(LOWER(name), LOWER(TRIM(city)), LOWER(TRIM(COALESCE(address, ''))), COALESCE(apple_maps_url, ''))`. Two screenshots of the same venue with different OCR-extracted address strings (or one missing, one present) will key differently and render as two rows in the trip's Places tab — even after both rows resolve to the same `external_place_id`. The OCR-key approach was the best signal available pre-enrichment; once `external_place_id` exists, it becomes the authoritative venue identity.

The query needs to switch to a venue-aware grouping when enrichment lands:

```sql
GROUP BY
  COALESCE(
    ep.external_place_id,                                -- preferred when resolved
    LOWER(ep.name) || '|' ||                             -- fallback for unresolved rows
    LOWER(TRIM(ep.city)) || '|' ||
    LOWER(TRIM(COALESCE(ep.address, '')))
  )
```

The result: resolved siblings collapse into one row per venue; unresolved siblings continue to use the OCR-key fallback (so newly captured screenshots still show in the Places tab before their first open triggers enrichment). The `MAX(...)` representative-picking inside the SELECT keeps working unchanged because the columns are within-group constants for resolved rows and arbitrary-pick for unresolved rows (same as today).

Other forward moves:
- The Apple geocoder native module (`modules/apple-geocoder`) becomes dead code once enrichment ships. Delete it then.
- The `latitude`, `longitude`, `formatted_address`, `apple_maps_url` columns on `extracted_places` (added by migration 0003) become dead. Leave them; cleanup migration is post-v0.2 churn we don't need.

**Net result:** the interim work (skipping geocoding, using search URLs, OCR-key dedup in the Places query) is not throwaway. The schema additions, the deep-link fallback, and the OCR-key fallback for unresolved rows all carry forward. The one item that needs an active code change at enrichment time is the `TRIP_PLACES_SQL` GROUP BY — flagged in the implementation order below.

## Cost model

Google Places (New) pricing as of 2026-05:
- Find Place from Text: $0.017 per request
- Place Details (Essentials + Pro mix): ~$0.020 per request
- Place Photos: $0.007 **per media request** (per display, not per enrichment — Google bills every photo fetch that misses cache)
- $200/month free credit (offsets the first ~5k worth of mixed calls)

Gemini flash-lite: ~$0.0005 per blurb.

### Per-venue first-enrichment cost
~$0.045 (Find Place + Details + first photo fetch + Gemini blurb). Charged once per venue per device — sibling screenshots of the same venue resolve via the pre-flight venue check and pay nothing.

### Recurring photo cost
The worker's `/photo/<name>` route sets `Cache-Control: public, max-age=2592000, immutable`. Cloudflare's edge cache absorbs repeats at each PoP. So:
- **Cache hit:** $0 to us, $0 to Google.
- **Cache miss** (first display per PoP, or after 30-day TTL): $0.007 to Google.

A power user opens a place ~3-5 times over its lifetime. Most reopens are within a single PoP and within the TTL — assume ~80% cache hit. Effective photo cost per place: ~$0.007 × 1.6 ≈ $0.011 (one initial fetch + ~0.6 expected misses across reopens), versus the naive ~$0.035 if every reopen billed.

### Power-user month
- Saves: ~200 places/month, of which ~30 are unique venues opened (rest are noise / never opened / dupes of saved venues).
- Opens: ~30 first-time opens × $0.045 = $1.35.
- Reopens: ~30 venues × ~3 reopens × $0.011 = $0.99.
- **Total: ~$2.35/month.** Still well under premium ARPU.

(Pre-fix this analysis claimed $1.35/month by ignoring reopen photo billing entirely — corrected after Codex review.)

### Scale check
10k MAU at the same engagement = ~$23.5k/month. Comfortably covered by premium revenue at any reasonable conversion + price point.

### Sensitivity
- **Photo cache hit rate matters most.** If the 30-day TTL turns out to be too aggressive (Google's `photo_name` gets invalidated and our cached body 404s on render), the recurring cost rises toward ~$0.035/venue. Keep an eye on it; shorten TTL only if we see broken-image reports.
- **Venue dedup matters second.** If the OCR-key pre-flight check misses common variants (e.g., "Kosoan" vs. "Ko-Sōan"), users pay multiple first-enrichment costs for one venue. The match is `LOWER(TRIM(...))`-only; consider Unicode-normalize before launch if real OCR data shows churn.
- **Pre-enriching at extraction time is still the wrong default.** Costs would scale with capture volume — ~7× higher (200 saves vs. 30 unique opens) — and we'd be paying for venues the user never looks at. Stay on-demand.

## Deferred / out of scope

- **Cross-user shared cache** — one Kosoan extracted across N users → one enrichment paid. Worth building once we have ~1k MAU; trivially layered onto the worker via D1 or KV keyed by `external_place_id`.
- **Eager pre-enrichment of first ~5 places on trip detail open** — perceived-speed win. Build the on-demand path first; layer this on if the loading state feels slow in practice.
- **Stale photo recovery** — `photo_name` is durable in the Places API contract, but Google occasionally invalidates references (closures, listing churn). When the worker's `/photo/<name>` returns 404, the client renders a "no image" placeholder; we do **not** auto-re-enrich. If broken images become a real complaint post-launch, add a "refresh" affordance on the place card that re-runs `/enrich` for that venue.
- **Persistent local photo cache** — Google ToS prohibits storing photo bytes long-term outside their CDN. The worker proxy's edge cache is permitted (transient, content-attributed); a client-side filesystem cache of photo bytes is not. Stick to in-memory image cache (RN's default).
- **Manual edit of an enriched place** — defer to v1.x feedback.
- **Re-enrichment after a venue closes / rebrands** — defer; too rare to design for.

## Open questions

- **Auth on the new `/enrich` and `/photo` endpoints** — `/extract` currently has no auth (per ROADMAP, auth lands at v1.0). Both new endpoints should follow the same posture so they ship/auth together. `/photo` is the higher-abuse-risk one (a cheap unauthenticated fetch that could be scraped); rely on the worker rate-limit binding pre-v1.0 and add the same RevenueCat-entitlement gate as `/extract` at v1.0.
- **Photo display dimensions** — pick concrete `w`/`h` values once the place card design is final. The `/photo/<name>?w=…&h=…` route already accepts them as query params.
- **Photo edge-cache TTL** — 30 days is a guess. Longer means lower cost; shorter means faster recovery from Google-side photo invalidation. Revisit if we see broken-image reports in TestFlight.

## Implementation order

0. **(Interim, ships before enrichment.)** Add `lib/openInMaps.ts` and switch `PlaceRow.tsx` from its hardcoded Apple Maps URL to the helper. No new schema, no worker work — just a small client refactor that immediately gives Google-Maps users their preferred app. Inputs are the data already on `PlaceRowData` (`name`, `city`, `address`); lat/lng/`external_place_id` paths in the helper are stubbed out for now and start producing pinned URLs once enrichment writes those fields.
1. Worker: add `/enrich` endpoint (Google Places client wired to `GOOGLE_PLACES_API_KEY`, Gemini blurb prompt via existing AI Gateway routing, response schema with `photo_name`) and `/photo/<name>` proxy route with edge-cache headers. Tests for happy-path, not-found, error classification, and the `/photo` route's name-shape validation.
2. Migration: create `place_enrichments` table, add `external_place_id`/`enrichment_status`/`enriched_at` to `extracted_places`, add the `external_place_id` index.
3. Client: enrichment runner (mirrors `extraction.ts` shape) with the pre-flight venue check, sibling propagation, in-flight dedup keyed by OCR-key, and the `'pending' | 'failed'` retry trigger.
4. **Update `TRIP_PLACES_SQL`** in `app/trips/[id].tsx` to the venue-aware GROUP BY (`COALESCE(external_place_id, OCR-key)`) and JOIN against `place_enrichments` for the display fields. Update `PlaceRow` to render the enriched card variant when joined data is present, and to pass `latitude` / `longitude` / `external_place_id` to `lib/openInMaps.ts` so the deep link upgrades from search-string to pinned.
5. UI: enriched place card variant (photo via `/photo/<name>` + blurb + rating). Skeleton loading state. Photo error placeholder.
6. Delete `modules/apple-geocoder` (Swift module + TS wrapper).
