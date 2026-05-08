# Place enrichment — design

**Status:** future feature, design locked.
**Driver:** "User can actually see what the place is — not just derive it from the screenshot."
**Date:** 2026-05-08

## Context

Today an extracted place is just a name, a city, an address (when present), and a category. To recognize a café you screenshotted three months ago, you have to re-open the original screenshot and read it. That defeats the wedge — *save it before it's lost* — because the saved-state is barely better than the camera roll it replaced.

Enrichment closes that gap: each place gets a real photo of the venue, a 1-2 sentence narrative, and structured metadata (rating, hours, price level). The place becomes a glanceable card.

## Decisions

| Decision | Choice | Reasoning |
|---|---|---|
| **MVP geocoding** | Skipped — `apple_maps_url` is a search-URL deep link with the full address | Apple's `CLGeocoder` / `MKLocalSearch` APIs are unreliable for non-English-script countries (Japanese addresses fail routinely). Investing in a server-side geocoder would be wasted work; enrichment provides geocoding as a free side-effect. |
| **Enrichment trigger** | On-demand, when the user opens a place card that hasn't been enriched | Travel-screenshot apps have heavy-save / light-browse usage. Most saved places are never viewed. On-demand pays only for engagement. ~500ms first-view loading state is acceptable; cached forever after. |
| **Premium gate** | None — enrichment is free for all users | Enrichment IS the value-prop "magic moment." Gating it would hurt the demo and word-of-mouth. Premium gates other things (cloud sync, unlimited trips). |
| **Data source — facts** | Google Places API (New) | Best worldwide coverage for the long tail of small/trendy venues that dominate Instagram travel content. Foursquare is ~70% of the cost but noticeably weaker in Asia. |
| **Data source — narrative** | Gemini (already wired through Cloudflare AI Gateway) | Google Places' `editorial_summary` field is sparse. Gemini synthesizes a 1-2 sentence blurb from Places' structured fields + the OCR caption. Costs ~$0.0005/place via flash-lite. |
| **Photo handling** | Display via Google's CDN URL, no caching | Google Places ToS requires display via their photo URL. Photo URLs are stable indefinitely as long as the underlying `photo_reference` is valid. |
| **Schema** | New columns on existing `extracted_places` table | One-to-one with the place row. No need for a separate enrichment table at this scale. |

## Architecture

A new worker endpoint sits next to `/extract`:

```
POST https://trip-pocket-extract-proxy.<subdomain>.workers.dev/enrich
Body: { extracted_place_id, name, city, address }
```

Flow inside the worker:

1. **Find Place from Text** (Google Places) — input: `"<name>, <address || city>"` → output: `place_id` + lat/lng + formatted_address.
2. **Place Details** (Google Places, `place_id`) — output: photos, rating, price_level, types, opening_hours, website, url.
3. **Gemini blurb** — prompt: structured fields from step 2 + the original OCR caption. Output: a 1-2 sentence narrative.
4. **Merged response** to the app:

   ```json
   {
     "external_place_id": "ChIJ…",
     "latitude": 35.6076,
     "longitude": 139.6680,
     "formatted_address": "1 Chome-24-23 Jiyugaoka, Meguro City, Tokyo 152-0035, Japan",
     "apple_maps_url": "https://maps.apple.com/?ll=35.6076,139.6680&q=Kosoan",
     "photo_url": "https://places.googleapis.com/v1/places/ChIJ…/photos/…/media?key=…",
     "description": "Cozy 1950s tea house in residential Jiyugaoka, known for matcha and traditional sweets.",
     "rating": 4.5,
     "price_level": 2,
     "external_url": "https://maps.google.com/?cid=…",
     "model": "gemini-2.5-flash-lite"
   }
   ```

Error classification mirrors `/extract`:
- 200 — success (or `"not-found"` body when Find Place returned zero matches).
- 4xx — permanent (bad input, no retry).
- 429 — rate-limited (worker rate limit binding).
- 5xx — retryable.

The worker reuses the existing rate-limit binding (per-IP, 100 req/60s) and the existing AI Gateway routing for the Gemini step.

## Schema additions

A future migration adds these columns to `extracted_places`:

```sql
ALTER TABLE extracted_places ADD COLUMN external_place_id TEXT;
ALTER TABLE extracted_places ADD COLUMN photo_url TEXT;
ALTER TABLE extracted_places ADD COLUMN description TEXT;
ALTER TABLE extracted_places ADD COLUMN rating REAL;
ALTER TABLE extracted_places ADD COLUMN price_level INTEGER;
ALTER TABLE extracted_places ADD COLUMN external_url TEXT;
ALTER TABLE extracted_places ADD COLUMN enrichment_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE extracted_places ADD COLUMN enriched_at TEXT;
```

`enrichment_status` values: `'pending' | 'enriched' | 'not-found' | 'failed'`.

Existing columns get reused, not replaced:
- `latitude`, `longitude`, `formatted_address`, `apple_maps_url` — populated by enrichment, NULL until then. Today these stay NULL (we skipped Apple geocoding).
- `address` — already populated by Gemini extraction. The input to enrichment.

## Client-side flow

When the user opens a place row whose `enrichment_status = 'pending'`:

1. Render the existing OCR-based card immediately (skeleton state with name + address + category icon).
2. Fire a background `POST /enrich` request.
3. On success: write the enriched columns into SQLite via a transaction, set `enrichment_status = 'enriched'`, `enriched_at = now()`. The live-query subscription re-renders the card with photo + description.
4. On `'not-found'`: store status, no UI change. The card stays in OCR-only form. Don't retry.
5. On `'failed'`: store status. Each subsequent open of the card retries automatically — no retry budget. Reasoning: the user re-opening a card is an explicit signal they want the data, and the worker's own rate-limit binding caps the blast radius.

In-flight dedup: a per-process `Set<string>` of `extracted_place_id`s currently being enriched, so multiple taps don't fire duplicate requests.

## Forward-compatibility check (MVP design stays valid)

The MVP simplification (skip geocoding, use search-URL deep links) consists of three decisions, each forward-compatible with the enrichment design:

- **Skip geocoding** — `extraction.ts` will not call any geocoder. `latitude`, `longitude`, `formatted_address`, `apple_maps_url` are all NULL when the row is inserted.
- **Search-URL deep link** — `PlaceRow.tsx` falls back to `https://maps.apple.com/?q=<name, address || city>` when `apple_maps_url` is NULL. Apple Maps' consumer app resolves the search server-side and pins correctly. (This requires a small change from the current code, which builds the URL from `name, city` only — the `address` field needs to be added to `PlaceRowData` and used in the fallback.)
- **`address` column** — populated by Gemini at extraction time (already shipped); this is the input to future enrichment.

Each one is forward-compatible:

- The schema columns enrichment will fill (`latitude`, `longitude`, `formatted_address`, `apple_maps_url`) already exist as nullable. No migration churn.
- `PlaceRow.tsx`'s fallback logic (`apple_maps_url || ?q=...`) keeps working: pre-enrichment uses the search URL; post-enrichment uses the `?ll=` pin URL written by the worker.
- The Apple geocoder native module (`modules/apple-geocoder`) becomes dead code once enrichment ships. Delete it then.

**Net result:** the work we're doing today (skipping geocoding, using search URLs) is not throwaway. The schema, the column semantics, and the deep-link fallback all carry forward unchanged.

## Cost model

Google Places (New) pricing as of 2026-05:
- Find Place from Text: $0.017 per request
- Place Details (Essentials + Pro mix): ~$0.020 per request
- Place Photos: $0.007 per displayed photo
- $200/month free credit ≈ ~5k full enrichments

Gemini flash-lite: ~$0.0005 per blurb.

**Per enriched place:** ~$0.045 worst case (Find Place + Details + 1 photo + Gemini).

**Engagement assumption:** a power user saves ~200 places/month, opens ~30 of them. With on-demand enrichment that's 30 × $0.045 = **$1.35/month**. Well under premium ARPU.

**Scale check:** 10k MAU at the same engagement = ~$13.5k/month. Comfortably covered by premium revenue at any reasonable conversion + price point.

The on-demand model is the cost-discipline lever. If we ever switch to pre-enriching at extraction time, costs scale with capture volume (20× higher) and require revisiting.

## Deferred / out of scope

- **Cross-user shared cache** — one Kosoan extracted across N users → one enrichment paid. Worth building once we have ~1k MAU; trivially layered onto the worker via D1 or KV keyed by `external_place_id`.
- **Eager pre-enrichment of first ~5 places on trip detail open** — perceived-speed win. Build the on-demand path first; layer this on if the loading state feels slow in practice.
- **Photo refresh / staleness** — Google's `photo_reference`-derived URLs are stable indefinitely. Treat enrichment as immutable for v1; revisit only if photos start 404'ing in production.
- **Offline cache of photos** — Google ToS forbids it. Don't.
- **Manual edit of an enriched place** — defer to v1.x feedback.
- **Re-enrichment after a venue closes / rebrands** — defer; too rare to design for.

## Open questions

- **API key separation** — does Google Places use the same key as Gemini (single `GOOGLE_API_KEY`) or a dedicated `GOOGLE_PLACES_API_KEY`? Lean: dedicated key with Places API enabled and bundle/IP restrictions. Decide at implementation time.
- **Auth on the new `/enrich` endpoint** — `/extract` currently has no auth (per ROADMAP, auth lands at v1.0). `/enrich` should follow the same posture so they ship/auth together.
- **Photo display dimensions** — Google Places photos can be requested at specific max dimensions. Pick once we have the place card design.

## Implementation order (when this is picked up)

1. Worker: add `/enrich` endpoint, Google Places client, Gemini blurb prompt, response schema. Tests for happy-path, not-found, error classification.
2. Migration: add the new columns to `extracted_places`.
3. Client: enrichment runner (mirrors `extraction.ts` shape), in-flight dedup set, status state machine.
4. UI: enriched place card variant (photo + blurb + rating). Skeleton loading state.
5. Delete `modules/apple-geocoder` (Swift module + TS wrapper).
