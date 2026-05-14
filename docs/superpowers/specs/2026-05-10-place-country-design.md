# Place Country — Design

**Date:** 2026-05-10
**Status:** ready for review
**Roadmap:** small follow-on to the shipped AI-extraction + Google-Places-enrichment pipeline. Adds the structured-country signal needed for the next iteration of the trip Places tab.

## Goal

Persist a structured country code on every `places` row so the trip Places tab can group its rows by country. The grouping matters most for multi-country trips (e.g. "Europe 2026"); single-country trips render flat with no visible change.

After this ships, the trip Places query selects `country_code`, and the Places tab renders one section per country (header label looked up via a static `COUNTRY_NAMES` map).

## Non-goals

- Cross-trip "all places" view filtered by country. Not asked for; defer.
- Inbox-level filter by country. Same.
- Auto-trip-name suggestion based on extracted countries (e.g. "we noticed this is a Japan trip"). Future spec.
- Long-name country column. ISO-2 only on storage; display name resolved at render time from a static English map.
- Sub-country regions (state, prefecture, admin_area_level_1). The use case is country-level grouping; finer granularity is YAGNI.
- Backfill of existing rows. Pre-launch dev DB. We purge and re-extract instead of writing a backfill script.
- New `0002_*` migration file. Schema is still in flux pre-launch; the project convention (see `0001_init.ts` comment) is to fold changes into `0001_init.ts` and document a one-time dev-DB wipe.
- Per-source provenance for the LLM's country guess (i.e. `place_sources.extracted_country_code`). No consumer needs it; YAGNI.

## Context

Current pipeline, verified against code:

1. **`/extract`** (Gemini 2.5 Flash-Lite, `workers/extract-proxy/src/prompt.ts`) returns per place: `name`, `city`, `address`, `category`.
2. **`/enrich`** (Google Places API New, `workers/extract-proxy/src/enrich.ts`) returns: `external_place_id`, `latitude`, `longitude`, `formatted_address`, `photo_name`, `description`, `rating`, `price_level`, `external_url`, `model`.
3. **`places` table** (`modules/storage/migrations/0001_init.ts`) carries both halves of the pipeline as columns on a single row. LLM writes `name`/`city`/`category` at INSERT; enrichment UPDATEs the Google-Places-derived columns later.

The gap: nothing stores **country** as a structured value. `formatted_address` contains the country as a string suffix ("…, Tokyo 152-0035, Japan") but parsing it is locale-fragile, and rows where enrichment returned `not-found` don't even have that.

Symmetric gap on `city`: today `places.city` is written by the LLM at INSERT and **never overwritten by enrichment**, even though Google Places returns an authoritative `addressComponents.locality`. This spec fixes both halves at once.

## Architecture

No new modules, no new endpoints. The change is additive across the existing pipeline:

```
OCR text
   │
   ▼
/extract (Gemini)  ── now also returns country_code (ISO-2)
   │
   ▼
INSERT INTO places (name, city, category, country_code, …)
   │
   ▼
/enrich (Google Places)  ── now also returns city + country_code from addressComponents
   │
   ▼
UPDATE places SET city = ?, country_code = ?, lat = ?, lng = ?, formatted_address = ?, …
   │
   ▼
Trip Places tab query  ── GROUP BY country_code, render section per country
```

Stage authority:

| Field                                                      | INSERT (extraction) | UPDATE (enrichment)                   | Authoritative when           |
| ---------------------------------------------------------- | ------------------- | ------------------------------------- | ---------------------------- |
| `name`                                                     | LLM                 | (unchanged)                           | Always LLM                   |
| `category`                                                 | LLM                 | (unchanged)                           | Always LLM                   |
| `city`                                                     | LLM                 | **Google Places `locality`**          | Enriched: Google. Else: LLM. |
| `country_code`                                             | **LLM (new)**       | **Google Places `country.shortText`** | Enriched: Google. Else: LLM. |
| `latitude`/`longitude`/`formatted_address`/`description`/… | (NULL)              | Google Places                         | Enriched only                |

`not-found` rows keep whatever the LLM wrote — that's the whole point of dual-write. Pure-Google-Places would leave them NULL.

## Components

### `0001_init.ts` — add one column

```sql
CREATE TABLE IF NOT EXISTS places (
  …
  city               TEXT,
  country_code       TEXT,           -- new: ISO 3166-1 alpha-2, e.g. 'JP', 'US'
  category           TEXT,
  …
);
```

No constraint, no index. Length-2-uppercase is enforced upstream (Zod schema on the proxy + LLM `responseSchema` `maxLength`). Dev DB wipe required — covered by the existing migration comment.

### `workers/extract-proxy/src/prompt.ts` — extend system prompt + Gemini schema

Add `country_code` to the per-place object in the prompt:

> - `country_code`: ISO 3166-1 alpha-2 **uppercase** code of the country the place is in (e.g. "JP", "US", "FR"). Always uppercase, exactly two letters. Infer from context (country name, currency, language, city). Empty string if truly ambiguous — never guess. Never emit 3-letter codes or full country names.

Add to `GEMINI_RESPONSE_SCHEMA.items.properties`:

```ts
country_code: { type: 'STRING' },
```

Add `'country_code'` to the per-place `required` array. (Empty string is the "unknown" sentinel — the schema still requires the field to be present, mirroring `city`/`address`.)

### `workers/extract-proxy/src/schema.ts` — Zod mirror

```ts
country_code: z.unknown().transform((v) => {
  if (typeof v !== 'string') return '';
  const upper = v.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(upper) ? upper : '';
}),
```

**Lenient per-place coercion.** Any input that isn't a recognisable ISO-2 code becomes empty string:

| Gemini sends                             | Stored           |
| ---------------------------------------- | ---------------- |
| `"JP"`                                   | `"JP"`           |
| `"jp"` / `"  jp  "`                      | `"JP"` (coerced) |
| `""`                                     | `""`             |
| field missing                            | `""`             |
| `"JPN"` / `"Japan"` / `"J"` / non-string | `""`             |

Empty string normalises to NULL at the storage boundary in `extraction.ts`. Rationale: a single bad apple should never blow up the whole extraction batch — drop the bad value, keep the place, let enrichment fill country authoritatively from Google Places. There is no "loud failure" signal for schema drift in v0.2; if Gemini consistently emits malformed country_code, the symptom is rows with NULL country until enrichment runs. Add Sentry/telemetry coverage when v0.3 lands.

The client's Zod (`modules/extraction/proxy.ts`) applies the same coercion — defense-in-depth for the case where the worker version lags the client.

### `workers/extract-proxy/src/enrich.ts` — extend field mask + parser

In `getPlaceDetails`, add `addressComponents` to the field mask string. Parse the response:

```ts
function pickComponent(
  components: AddressComponent[],
  type: string,
): { shortText?: string; longText?: string } | null {
  return components.find((c) => c.types?.includes(type)) ?? null;
}

const locality = pickComponent(obj.addressComponents ?? [], 'locality')?.longText ?? null;
const country = pickComponent(obj.addressComponents ?? [], 'country')?.shortText ?? null; // ISO-2
```

Extend `PlaceDetails` + `EnrichResponse` with `city: string | null` and `country_code: string | null`. The 'not-found' branch is unchanged (no city/country_code in that response shape).

### `modules/enrichment/proxy.ts` + `enrichment.ts` — pass-through

`EnrichmentResult` type widens to include `city` and `country_code`. The enrichment write path UPDATEs both columns on `places`. Only override when the proxy returned non-null/non-empty; if Google didn't supply a locality (rare, e.g. some rural place), don't clobber the LLM value with NULL.

```ts
UPDATE places
   SET city              = COALESCE(?, city),
       country_code      = COALESCE(?, country_code),
       latitude          = ?,
       longitude         = ?,
       formatted_address = ?,
       …
 WHERE id = ?;
```

`COALESCE(?, col)` only overrides when the new value is non-NULL — preserves the LLM-extracted value when Google has nothing better.

### `modules/extraction/extraction.ts` + `proxy.ts` — pass-through

`ExtractedPlace` widens to include `country_code: string`. The INSERT path writes it to `places.country_code`. Empty-string LLM output stored as NULL on the way in (one canonical "unknown" representation in the DB).

**Dedup-match path.** When an extraction matches an existing `places` row by `normalized_key`, we add a `place_sources` link. For `country_code` we adopt an **asymmetric fill** rule:

- Existing `country_code` is non-NULL → leave it alone. Re-extractions never overwrite a non-empty value (mirrors `city`/`name`/`category` posture).
- Existing `country_code` is NULL AND new extraction supplied a non-empty ISO-2 → fill it. This gives the LLM a second chance to populate country on rows that were created from an ambiguous source.

Asymmetric fill is safe because the LLM's confidence sentinel is NULL/empty — filling NULL is a strict information gain, never a contradiction.

**Known limitation: cross-country same-name+same-city collisions.** `normalized_key` is `LOWER(name)|LOWER(city)` and does not include country. Two distinct places that share both name and city across different countries (Cambridge MA "Flour Bakery" vs Cambridge UK "Flour Bakery") collapse onto one `places` row. This is a pre-existing limitation, not introduced by this spec — every Google-Places-derived field (`formatted_address`, `lat/lng`, etc.) already suffers from it. `country_code` inherits the same trade-off. Acceptable for v1; if it becomes a real complaint, the fix is to extend `normalized_key` to include `country_code`, which is a separate spec.

### `modules/storage/places.ts` — column lists

Add `country_code` to the INSERT column list and the UPDATE column list on the enrichment-write path. `Place` row type gains `country_code: string | null`.

### Trip Places tab (`app/trips/[id].tsx`) — group by country

The Places tab is today a flat 2-column grid of `PlaceTile`s (`app/trips/[id].tsx:168-174`). This spec **keeps the grid layout** and only inserts country headers between groups when there is more than one country in the trip.

Extend `TRIP_PLACES_SQL` to select `country_code` (no SQL grouping — group at render time, small N).

Render rules:

| Buckets present                             | UI                                                                                                                                                                                     |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One non-null bucket (and no unknown bucket) | Existing flat 2-column grid, no section headers. Single-country trips look identical to today.                                                                                         |
| One non-null bucket + an unknown bucket     | Existing flat grid for the known country (no header), then a small "Other" header followed by another 2-column grid for unknowns. Header only renders when both buckets are non-empty. |
| Multiple non-null buckets                   | One section per country, each rendered as a 2-column grid with a header above. Sort sections by row count desc within the trip; unknown bucket last.                                   |

**Layout primitive.** Stay with the existing flex-wrap pattern, not `SectionList`. The render becomes a plain map over `[{ code, places }, …]`, emitting `<CountrySectionHeader />` then a flex-wrap row of `PlaceTile`s per group. Avoids restructuring the tab into a virtualised list.

**Header style.** Match existing section-header treatment in the app (e.g. inbox list-section labels): system gray, footnote weight, uppercased, with the same horizontal padding as the grid (`px-4`).

**Code → name display.** Ship a static `COUNTRY_NAMES: Record<string, string>` map in `components/CountryDisplay.ts` (~250 entries, English names, ~5KB). Lookup with `COUNTRY_NAMES[code] ?? code` (falls back to the raw code if the LLM/Google ever produces a code we didn't include — shouldn't happen, but defensive).

**Why not `Intl.DisplayNames`?** Hermes' `Intl` support on RN 0.83 / Expo 55 does not list `Intl.DisplayNames` as guaranteed; relying on it risks runtime failures on device. A static map is ~5KB, fully deterministic across runtimes, and English-only matches the app's current single-locale posture. Revisit if/when the app gains localized labels.

## Data flow

```
Screenshot OCR text →
  /extract → [{ name, city, country_code, address, category }, …]
            (country_code is ISO-2 or '')
    │
    │ (per place)
    ▼
  upsert into places (LLM is the source of truth for country_code at this point)
    │
    ▼
  enqueue enrichment
    │
    ▼
  /enrich → returns city + country_code from addressComponents (when status=enriched)
    │
    ▼
  UPDATE places SET city = COALESCE(?, city), country_code = COALESCE(?, country_code), …
    │
    ▼
  Trip Places tab refresh: GROUP BY country_code
```

## Failure modes

| Case                                                                                                      | Behavior                                                                                                                                                           |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| LLM omits `country_code` from a place                                                                     | Coerced to empty string by per-place Zod transform → stored as NULL. Place is still saved.                                                                         |
| LLM emits lowercase (`"jp"`)                                                                              | Uppercased and accepted.                                                                                                                                           |
| LLM emits 3-letter (`"JPN"`), full name (`"Japan"`), 1-char, non-string                                   | Coerced to empty string → stored as NULL. Place is still saved.                                                                                                    |
| LLM emits `""` (ambiguous)                                                                                | Stored as NULL in `places.country_code`. Place lands in the "Other" bucket until enriched (or until a later same-place extraction fills NULL via asymmetric-fill). |
| One place in a multi-place batch has a bad country_code                                                   | That single place's country_code becomes empty/NULL. All sibling places persist normally. Whole-batch failure is **not** triggered by per-field validation.        |
| Google `addressComponents.country.shortText` is lowercase (CLDR convention says uppercase, but defensive) | Normalise to uppercase in the Worker before serialising the response. Client never sees mixed case.                                                                |
| Same-name + same-city across countries (Cambridge UK + Cambridge MA both "Flour Bakery")                  | Collide on `normalized_key`; one row wins. Acknowledged limitation, see "Dedup-match path" above.                                                                  |
| Google `addressComponents` missing the `country` entry                                                    | Rare. Parser returns null; `COALESCE` preserves LLM value.                                                                                                         |
| Google returns a different ISO-2 than the LLM                                                             | Google wins (the override is the whole point).                                                                                                                     |
| Place enriches to `not-found`                                                                             | `country_code` stays at whatever the LLM wrote (NULL or ISO-2).                                                                                                    |
| Place hasn't been enriched yet (`pending`)                                                                | Same: LLM value is what shows.                                                                                                                                     |
| Trip has one country but a few unknown-bucket rows                                                        | Flat list for the known country, small "Other" section at the bottom.                                                                                              |

## Open questions / decisions made

Resolved:

| Question                                        | Decision                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Storage shape                                   | Single column `places.country_code TEXT`, ISO 3166-1 alpha-2 uppercase. No long-name column.                                                                                                                                                                                                                                                |
| Display                                         | Static English `COUNTRY_NAMES` map in `components/CountryDisplay.ts` (~250 entries, ~5KB). No `Intl.DisplayNames` — Hermes support is not guaranteed on RN 0.83.                                                                                                                                                                            |
| Localisation                                    | English-only labels for v1. If/when the app ships in other locales, swap the static map for `Intl.DisplayNames` or a per-locale map.                                                                                                                                                                                                        |
| Write path                                      | Both: LLM at INSERT, Google Places at UPDATE. Enrichment uses `COALESCE` so it only overrides when Google has a value.                                                                                                                                                                                                                      |
| Scope of override                               | Both `city` and `country_code` get the dual-write treatment. Fixes the pre-existing inconsistency where `city` was LLM-only forever.                                                                                                                                                                                                        |
| `not-found` rows                                | Keep LLM-extracted values (the whole reason for dual-write).                                                                                                                                                                                                                                                                                |
| LLM ambiguity sentinel                          | Empty string from the LLM; stored as NULL in the DB.                                                                                                                                                                                                                                                                                        |
| Format enforcement                              | **Lenient per-place coercion**, not strict rejection: at the worker and the client, any non-conforming `country_code` becomes empty string (→ NULL downstream). A single bad place never fails the whole batch. Downstream code can assume uppercase ISO-2 or NULL. Google's `shortText` defensively normalised to uppercase in the Worker. |
| Dedup-match write                               | Asymmetric fill: replace NULL with non-empty values; never overwrite a non-NULL existing value.                                                                                                                                                                                                                                             |
| Cross-country same-name+same-city collisions    | Acknowledged pre-existing limitation of `normalized_key = name                                                                                                                                                                                                                                                                              | city`. Affects `country_code` exactly as it affects every other Google-Places-derived column. Out of scope to fix here. |
| Per-source provenance for country               | Out of scope. `place_sources` does not gain an `extracted_country_code` column.                                                                                                                                                                                                                                                             |
| Migration shape                                 | Edit `0001_init.ts` in place; dev DB wipe (matches the existing comment in that file).                                                                                                                                                                                                                                                      |
| Backfill                                        | None. Pre-launch.                                                                                                                                                                                                                                                                                                                           |
| Trip-Places SQL grouping                        | Group at render time, not in SQL. Small N.                                                                                                                                                                                                                                                                                                  |
| Trip-Places layout                              | Stay on the existing flex-wrap 2-column grid; insert section headers between country groups when >1 country. No `SectionList` migration.                                                                                                                                                                                                    |
| `regionCode` hint to Google Places `searchText` | **Optional** follow-up. Adding `regionCode: <country_code>` to the searchText body, when LLM provided one, would disambiguate "Cambridge" globally. Defer until evidence it matters.                                                                                                                                                        |

Deferred:

- Cross-trip "all places" view filtered by country.
- Country-based inbox filter.
- Country-derived auto-suggestion at trip creation.
- Sub-country region grouping.

## Testing

**Worker (`workers/extract-proxy/__tests__/`):**

- `extract`: stubbed Gemini returns a place with `country_code: "JP"` → 200 response contains it; Zod accepts.
- `extract`: stubbed Gemini returns lowercase `"jp"` → 200, response contains `"JP"` (coerced).
- `extract`: stubbed Gemini returns 3-letter code → 200, response contains `""` (per-place coercion). The place is still saved.
- `extract`: stubbed Gemini omits `country_code` → 200, response contains `""`. The place is still saved.
- `extract`: one good + one bad country_code in the same batch → both places returned; only the bad one's `country_code` is empty.
- `enrich`: stubbed Google Places returns `addressComponents` with a `country` entry → response includes `country_code: "JP"`.
- `enrich`: stubbed Google Places returns `addressComponents` without a `country` entry → response includes `country_code: null`; `city: null` similarly.
- `enrich`: not-found branch unchanged (no city/country_code in body).

**Client (`modules/extraction/__tests__/`, `modules/enrichment/__tests__/`):**

- Extraction proxy adapter: LLM empty-string `country_code` → INSERT writes NULL.
- Extraction proxy adapter: LLM "JP" → INSERT writes "JP".
- Extraction dedup-match: existing place with `country_code = NULL`, new extraction supplies "JP" → asymmetric fill writes "JP".
- Extraction dedup-match: existing place with `country_code = "JP"`, new extraction supplies "" → no write; "JP" preserved.
- Extraction dedup-match: existing place with `country_code = "JP"`, new extraction supplies "KR" → no write; "JP" preserved (re-extractions never overwrite a non-empty value).
- Enrichment write path: response with city + country_code → UPDATE writes both, overriding LLM values.
- Enrichment write path: response with null city → COALESCE preserves the LLM-extracted city. Same for country_code.
- Enrichment write path: `not-found` response → LLM-extracted city + country_code remain on the row.
- Worker enrich path: Google `addressComponents.country.shortText = "jp"` (defensive) → response includes `"JP"` (uppercase).

**Storage (`modules/storage/__tests__/`):**

- `0001_init` schema test asserts `country_code` column exists on `places`.

**Trip-Places UI:**

- Trip with all rows in one country → existing flat 2-column grid, no section headers (regression guard against headers leaking into single-country trips).
- Trip with one country + one unknown row → flat grid for the country, "Other" header + grid for unknowns.
- Trip with three countries → three sections, ordered by row count desc, each rendered as a 2-column grid, header text from `COUNTRY_NAMES`.
- Trip with a code missing from `COUNTRY_NAMES` (defensive — shouldn't happen) → header falls back to the raw ISO-2 code; layout doesn't crash.

## File-change inventory

**New:**

- `components/CountryDisplay.ts` — static `COUNTRY_NAMES: Record<string, string>` (ISO-2 → English name) plus a `displayCountry(code)` helper. ~250 entries.

**Modified:**

- `modules/storage/migrations/0001_init.ts` — add `country_code TEXT` to `places`.
- `workers/extract-proxy/src/prompt.ts` — extend system prompt + `GEMINI_RESPONSE_SCHEMA`.
- `workers/extract-proxy/src/schema.ts` — extend Zod schema with `country_code: z.string().regex(/^([A-Z]{2})?$/)`.
- `workers/extract-proxy/src/enrich.ts` — add `addressComponents` to field mask, parse locality + country, normalise country to uppercase, extend `PlaceDetails` + `EnrichResponse`.
- `workers/extract-proxy/__tests__/` — new test cases as above.
- `modules/extraction/proxy.ts` + `extraction.ts` — widen `ExtractedPlace`; INSERT writes `country_code`; dedup-match path implements asymmetric fill.
- `modules/enrichment/proxy.ts` + `enrichment.ts` — widen `EnrichmentResult`; UPDATE writes city + country_code with `COALESCE` override.
- `modules/storage/places.ts` — column lists + row type.
- `app/trips/[id].tsx` — extend `TRIP_PLACES_SQL` with `country_code`; group at render; insert `<CountrySectionHeader>` between groups when >1 country.
- `components/PlaceTile.tsx` — no change required for grouping itself. Touch only if you also want to surface country on the tile body.

**Deleted:** none.

## Implementation order suggestion

1. Schema column on `places` (edit `0001_init.ts`). Storage test asserts the column.
2. Worker `/extract` extension (prompt + schema + Zod). Worker tests.
3. Client extraction widening (`ExtractedPlace`, INSERT). Unit test.
4. Worker `/enrich` extension (field mask + parser + response shape). Worker tests.
5. Client enrichment widening (UPDATE with COALESCE). Unit test.
6. Trip-Places tab grouping + section rendering.
7. Manual smoke on device with a multi-country trip (e.g. mixed Japan + Korea screenshots) before declaring done.
