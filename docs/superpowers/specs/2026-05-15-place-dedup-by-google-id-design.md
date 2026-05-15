# Place dedup by Google Place ID — design

**Status:** draft (2026-05-15, rev 2 after Codex review) · awaiting review before implementation plan
**Touches:** `workers/extract-proxy/src/enrich.ts` (request `languageCode=en`, include `display_name` in response, with worker tests), `modules/enrichment/proxy.ts` (response schema), `modules/enrichment/enrichment.ts` (name override + recompute normalized_key on every successful enrichment, including the merge-skip path), tests in `modules/enrichment/__tests__/` and `workers/extract-proxy/__tests__/`.
**Milestone:** v0.4 — extraction quality / canonicalisation.

## Why

The user reports duplicate places: the same physical location, extracted from two different sources under slightly different names ("Joe's Pizza" vs "Joe's Pizza & Bar"), shows up as two separate rows in the inbox.

Today the place identity is set at extraction time and based purely on the LLM's text output:

```ts
normalizedKey = `${name.trim().toLowerCase()}|${city.trim().toLowerCase()}`;
```

(`modules/storage/places.ts:91-93`). The post-enrichment merge in `modules/enrichment/enrichment.ts:300-352` can catch some duplicates by Google Place ID, but only after both rows have been enriched, and only when their trips agree. Two LLM-name variants for the same physical place therefore survive as separate rows whenever: enrichment hasn't run on one side yet, one side returned `not-found`, one side hit a permanent failure, or the user assigned the two rows to different trips.

The fix is to make **Google Place ID the canonical identity** and **Google `displayName` the canonical name** for _newly enriched_ places. The LLM-derived row remains the _placeholder_ identity (cheap, offline, immediate). Once enrichment resolves a Google Place ID, that ID and that name become the source of truth for that row.

**This change is forward-only.** Existing duplicates in the user's database stay as-is. Backfilling — re-enriching old rows, renaming already-enriched winners, or sweeping pre-existing groups — is explicitly out of scope (see "Not in scope" below). The reasoning is that existing duplicates are tolerated, and any backfill costs Google API quota for marginal benefit on rows the user has already lived with.

## Scope

In scope:

- Worker sends `languageCode: 'en'` to both Places API (New) endpoints (`searchText` and `places/{id}`).
- Worker returns `display_name` in its enriched response payload (trimmed; empty/whitespace becomes `null`).
- Client response schema in `modules/enrichment/proxy.ts` gains `display_name: z.string().nullable().optional()`.
- On every successful enrichment, the client overwrites `places.name` from `display_name` (when non-null) and recomputes `places.normalized_key` from the (final-name, final-city) pair. Applies to _all three_ enrichment outcomes: no-collision write, merge-winner write, and the trip-equality merge-skip write.
- Worker tests for `languageCode=en` on both endpoints, `display_name` in the enriched response, empty/whitespace `display_name` normalised to `null`.
- Client tests for the four enrichment writes (no-collision, merge-winner, merge-skip, `display_name: null`), backward-compat with workers that omit `display_name`.

Not in scope (each may become its own sub-project):

- **Fixing existing duplicates.** No boot reconciler, no orphan re-enrichment sweep, no backfill rename of already-enriched rows. The change applies to enrichments that run after this ships.
- Manual "merge places" UI for the trip-equality skip case.
- Device-locale `languageCode` plumbing (option B from brainstorm) — defer until the app ships localized.
- Pre-insert fuzzy / alias matching at extraction time. Tier 2 stays as case-insensitive `name|city`.
- Changing the LLM extraction prompt. LLM continues to supply `name`, `city`, `address`, `category`, `country_code`; we just stop treating its `name` as canonical after enrichment.
- User-editable place names. No manual-edit field exists today; "preserve user edits" logic is not needed.
- Telemetry events for merge / rename.

## Decisions

**Google Place ID is the canonical identifier (forward-only).** Once a _newly enriched_ place row has a non-null `external_place_id`, that ID is what defines its identity. A row without an ID (pending, failed, or `not-found`) keeps the legacy `normalized_key`-driven identity as a degraded fallback. Rows that were enriched before this release keep their existing LLM-derived `name` and `normalized_key`; the new logic only fires the next time enrichment runs on a row.

**Google `displayName` is the canonical name (forward-only).** Every successful enrichment writes `places.name = display_name` (when Google returned a non-empty one) and recomputes `places.normalized_key = normalizePlaceKey(finalName, finalCity)`. Re-enrichment (e.g., the blurb-retry path) also re-applies — names stay fresh if Google updates `displayName`. If Google returns `display_name: null` (or an empty/whitespace string trimmed to null), the existing name on the row stays untouched.

**Name + normalized_key are computed in TypeScript before the SQL UPDATE.** The existing enrichment write also updates `city` via `COALESCE(?, city)`. If we let SQL compute `normalized_key` inline, it could use the _old_ city while writing the _new_ name — out of sync. Instead: compute `finalName = display_name ?? row.name`, `finalCity = enrichment.city ?? row.city` in TS, then write `name`, `city`, and `normalized_key = normalizePlaceKey(finalName, finalCity)` together.

**Skip-path also writes name + normalized_key.** When the post-enrichment collision-merge is skipped (different non-null trips on the two sides), today the code returns early and writes nothing on the incoming row. New behavior: still write `name`, `normalized_key`, and the _non-identifier_ enrichment columns (description, rating, photo, etc.) on the incoming row. The only field withheld is `external_place_id` (UNIQUE constraint forbids two live rows holding the same one). Result: the user sees Google's canonical name on both rows even when they remain unmerged.

**Language: force `languageCode=en`.** Trip Pocket's LLM extraction prompt is English, OCR'd captions skew English, and the v1 userbase is English-speaking. Forcing English means a Tokyo place shows as "Tokyo Tower" instead of "東京タワー" — readable for the target user. Both Places API endpoints accept `languageCode`; both gain it. Locale-aware language is deferred (see Not in scope).

**Trip-equality skip rule preserved.** The existing merger in `enrichment.ts:313-322` skips the merge when both sides have non-null, non-equal `trip_id`s. We keep this verbatim. Reasoning: the user has _explicitly_ sorted the two rows into different trips — there's a coherent product story where a restaurant on two itineraries is two places. Cross-trip merging would silently mutate user-curated state. A future "merge these?" suggestion UI can address it as a user-initiated action.

**Re-enrichment re-writes the name.** Every `enriched` outcome — first enrichment or retry — writes `display_name` to `places.name`. No "first-write wins" rule. Cost is one cheap UPDATE; benefit is the canonical name stays in sync if Google updates display names.

**`not-found` and failed enrichments keep their LLM name.** No `external_place_id`, no canonical name. The row sits with `enrichment_status = 'not-found'` and its LLM-derived `name` + `normalized_key`. The existing `findSoleMatchByNormalizedKey` path still dedupes them on next extraction. If/when a future re-enrichment succeeds (the `not-found` → `pending` re-attach path in `extraction.ts:209-216`), the canonical rules kick in.

## Data flow

**Pre-enrichment (unchanged):**

```
source captured → OCR → extraction
  → LLM emits {name, city, address, category, country_code} per place
  → findSoleMatchByNormalizedKey(normalize(name, city), ownerId)
       hit  → reuse existing place (asymmetric-fill country_code)
       miss → INSERT new place with LLM name + LLM normalized_key
              enrichment_status = 'pending'
  → linkPlaceSource(place_id, source_id)
```

The row's `name` and `normalized_key` are _placeholder_ values until enrichment runs.

**Enrichment (changed):**

```
enrichment.processOne(place_id)
  → enrichFromProxy({name, city, address, ocr_caption})
    → worker: places:searchText (textQuery, languageCode=en) → place_id
              places/{id}      (fields=..., languageCode=en)  → details
              gemini blurb
              returns {status: 'enriched', external_place_id, display_name, ...}
  → applyOutcome:
      not-found:
        setEnrichmentStatus('not-found'); keep LLM name

      enriched, no collision:
        finalName = display_name ?? row.name
        finalCity = enrichment.city ?? row.city
        UPDATE places SET
          name = ?,                                  -- finalName
          city = ?,                                  -- finalCity
          normalized_key = ?,                        -- normalizePlaceKey(finalName, finalCity)
          external_place_id = ?,                     -- Google ID
          ...other enrichment cols,
          enrichment_status = 'enriched'

      enriched, collision found, trips merge-eligible:
        // winner = pickWinner(incoming, collision), loser = the other
        transferJunctions(loser → winner)
        DELETE FROM places WHERE id = loser.id
        // Then on winner: same UPDATE as the no-collision branch above,
        // computing finalName/finalCity from the winner's current city + Google's
        // display_name and enrichment.city.

      enriched, collision found, trips NOT merge-eligible (skip):
        // Two non-null, non-equal trips on incoming and collision. UNIQUE constraint
        // forbids both rows holding the same external_place_id, so we withhold the
        // ID — but we still canonicalise the incoming row's name and the
        // descriptive enrichment columns.
        finalName = display_name ?? incoming.name
        finalCity = enrichment.city ?? incoming.city
        UPDATE places SET
          name = ?,                                  -- finalName
          city = ?,                                  -- finalCity
          normalized_key = ?,                        -- normalizePlaceKey(finalName, finalCity)
          -- external_place_id intentionally NOT written
          photo_name = ?, description = ?, rating = ?, price_level = ?,
          external_url = ?, latitude = ?, longitude = ?, formatted_address = ?,
          enrichment_status = 'enriched'             -- still considered "enriched";
                                                     -- the missing external_place_id
                                                     -- is the signal that this row is
                                                     -- a stuck duplicate, not unenriched.
          WHERE id = incoming.id
```

## Worker change

`workers/extract-proxy/src/enrich.ts`:

1. `searchText` body — add `languageCode: 'en'`:
   ```ts
   body: JSON.stringify({ textQuery, maxResultCount: 1, languageCode: 'en' });
   ```
2. `getPlaceDetails` URL — add `?languageCode=en`:
   ```ts
   fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}?languageCode=en`, …)
   ```
3. Response body — include `display_name` in the `'enriched'` payload sent to the client. The worker already extracts it (`details.displayName`); trim whitespace and treat empty results as `null`, then thread it into the response next to `formatted_address`.

The worker is deployed independently from the app. The client tolerates an older worker that omits `display_name` because the response schema makes it nullable + optional; in that case the LLM name persists, which is the current behavior. No coordinated rollout required.

## Client schema change

`modules/enrichment/proxy.ts` — the `'enriched'` branch of `responseSchema` gains:

```ts
display_name: z.string().nullable().optional(),
```

`optional()` keeps backward compat with an older worker that omits the field. `EnrichOutcome` (in `enrichment.ts`) gains `display_name: string | null` (defaulting to null when the worker omits the field).

## Tests

`modules/enrichment/__tests__/enrichment.test.ts` — new cases:

1. **Enrichment writes Google name (no collision).** Place inserted with LLM name "joe's pizza & bar"; enrichment returns `display_name: "Joe's Pizza"`. After: `places.name = "Joe's Pizza"`, `places.normalized_key = "joe's pizza|<city>"`, `external_place_id` set.
2. **Re-enrichment refreshes name.** Place enriched once with `display_name: "Old Name"`. A second `enrichFromProxy` call returns `display_name: "New Name"`. After: name and normalized_key reflect "New Name".
3. **`display_name: null` keeps existing name.** Worker returns `display_name: null`. The current row name persists; `normalized_key` is unchanged. Other enrichment columns (rating, photo, etc.) are still written.
4. **Worker omits `display_name` entirely.** Schema accepts the older response shape; existing name persists (same outcome as #3).
5. **Merge writes Google name onto winner.** Two rows ("joe's pizza" and "joe's pizza & bar"), same trip. Both enrich to the same Google ID with `display_name: "Joe's Pizza"`. After merge, winner has `name = "Joe's Pizza"` and `normalized_key = "joe's pizza|<city>"`; loser is deleted.
6. **Merge-skip path writes name + descriptive cols, withholds external_place_id.** Two rows with different non-null trips collide on a Google ID. After: incoming row has Google `display_name`, recomputed normalized_key, description/photo/rating/etc., but `external_place_id` stays NULL. Collision row is untouched.
7. **`finalCity` from enrichment is used when recomputing normalized_key.** Place inserted with LLM city "tokio"; enrichment returns `city: "Tokyo"` and `display_name: "Tokyo Tower"`. After: `name = "Tokyo Tower"`, `city = "Tokyo"`, `normalized_key = "tokyo tower|tokyo"` (uses the Google city, not the LLM one).

`workers/extract-proxy/__tests__/enrich.test.ts` — new cases:

8. **`searchText` request body includes `languageCode: 'en'`.**
9. **`places/{id}` request URL includes `?languageCode=en`.**
10. **Enriched response includes `display_name` from `details.displayName`.**
11. **Empty / whitespace `displayName` is serialised as `display_name: null`.**
12. **`displayName` absent on the Google response → `display_name: null` in worker output.**

## Open questions

None. All decisions are made above; the design is ready for implementation planning.
