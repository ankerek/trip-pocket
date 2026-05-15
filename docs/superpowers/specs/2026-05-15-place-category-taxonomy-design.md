# Place category taxonomy — design

**Status:** draft (2026-05-15, rev 2) · awaiting review before implementation plan
**Touches:** `workers/extract-proxy/src/prompt.ts` (SYSTEM_PROMPT + GEMINI_RESPONSE_SCHEMA), `workers/extract-proxy/src/schema.ts` (placeSchema enum), `workers/extract-proxy/__tests__/`, `modules/extraction/extraction.ts` (ExtractedPlaceInput type), `modules/extraction/proxy.ts` (response schema enum), `modules/storage/migrations/0008_category_rename.ts` (new), `modules/storage/migrations/0009_drop_tags.ts` (new), `modules/storage/trips.ts` (drop tags cascade), `modules/storage/sources.ts` (drop tags cascade), `modules/storage/places.ts` (drop tags cascade), `components/PlaceTile.tsx` (icon map + new visible category icon on the overlay), `components/PlaceRow.tsx`, `app/triage.tsx`, `components/onboarding/DemoPlaceCard.tsx`.
**Milestone:** v0.4 — extraction quality / canonicalisation.

## Why

Today every place lands in one of three buckets: `place`, `food`, `activity`. The LLM is told (`workers/extract-proxy/src/prompt.ts:10`):

> "food" for restaurants / cafés / bars / markets. "activity" for things to do (hikes, museums, viewpoints, tours, day-trips). "place" for everything else (hotels, neighborhoods, generic locations).

That collapses meaningfully different saves — a hotel, a viewpoint, a neighborhood, and a generic pin all map to `place`; a hike, a museum, and a guided tour all map to `activity`. The category drives the small icon on `PlaceTile`, `PlaceRow`, and the triage card, and a "Restaurant"/"Activity" label in triage. Beyond that, nothing — no filtering, no grouping.

The grouping the user actually wants when scanning a saved trip is closer to:
"where will I eat / drink / sleep / sight-see / do / shop?" — the canonical travel-guidebook split. Six buckets, not three, with the existing junk-drawer (`place`) broken up.

Bundled into this change is the **removal of the `tags` table.** It was introduced in `0001_init` for free-form `('place'|'food'|'activity')` tagging of sources, contributes to the `sources_fts` index, and has cascade-delete code in `trips.ts`, `sources.ts`, and `places.ts`. Nothing in the app writes to it — confirmed by a grep for `INSERT INTO tags` / `insertTag` returning zero hits. It's dead schema. Dropping it now (rather than later) keeps the FTS triggers focused on `ocr_text + trip name`, removes three defensive cascade DELETEs, and avoids confusing future readers who see a `tags` table and assume it's load-bearing.

## Scope

In scope:

- LLM prompt and Gemini response schema updated to six categories (`food`, `drinks`, `stays`, `sights`, `activities`, `shops`).
- Worker Zod schema (`placeSchema.category`) updated to the new enum.
- Client-side type and Zod schema (`ExtractedPlaceInput`, `modules/extraction/proxy.ts`) updated to the same enum.
- One-shot migration `0008_category_rename` rewrites legacy values: `'activity'` → `'activities'`, `'place'` → `NULL`. `'food'` stays as-is (meaning preserved).
- Icon map updates in `PlaceTile`, `PlaceRow`, triage, and the onboarding `DemoPlaceCard`. New SF Symbols chosen below.
- Triage label dictionary updated.
- **`tags` table removed.** Migration `0009_drop_tags` drops the table and rebuilds the `sources_fts_ai` / `sources_fts_au` triggers without the tag subquery. The three cascade DELETEs in `trips.ts:153`, `sources.ts:308`, and `places.ts:256` are removed.
- **Category icon visible on `PlaceTile`.** Today the category icon only renders in the no-photo fallback path; once a place is enriched (the common case), the icon disappears. New behaviour: small icon shown on every tile in the bottom overlay, prefixing the secondary line (`[icon] Tokyo · ★ 4.5`). Detailed in the UI section below.
- Worker + client tests for the new enum at both proxy and storage boundaries.
- Migration tests for both `0008_category_rename` and `0009_drop_tags`.

Not in scope (each can be its own sub-project):

- **Filter pills on the Places tab by category.** Mechanical, but a separate UX decision (filter pills currently filter by trip, not category — combining them needs thought). Build this once the categories ship and we see how skew distributes.
- **Plumbing Google Places `types[]` through to the client** ("Option B" from brainstorm 2026-05-15). The enrichment worker already fetches `types` but discards them. Layering them in as a subtype tag ("Food · Ramen shop") is a follow-up spec — adds a column, a worker field, and tile work. Independent.
- **Backfilling old `'place'` rows by re-running extraction.** Existing rows that were categorised `'place'` keep their fallback (generic pin); a user-triggered re-extract or a new save in the same place will reclassify. No automatic re-extraction sweep.
- **CHECK constraint on `places.category`.** SQLite can't `ALTER … ADD CONSTRAINT` so adding one needs a table rebuild. The Zod schemas at the proxy boundary and the client extraction boundary already enforce the enum; DB-level CHECK is belt-and-suspenders and not worth the migration churn.
- **Multi-category per place.** Single primary category per place stays the model; the eventual `types[]` subtype carries the secondary nuance.
- **Localized labels.** English-only labels, matching the rest of the app.

## Decisions

**Storage values are plural-noun keys.** `'food' | 'drinks' | 'stays' | 'sights' | 'activities' | 'shops'`. Stored as `TEXT` in `places.category`; the column is already nullable and untyped at the DB level (`places.category TEXT`). No CHECK constraint — Zod at the boundary is the enforcement.

Rationale for plural-noun keys (vs. verb keys like `'eat'/'drink'/'see'/'do'`):
- `'food'` already exists in the legacy data with the right meaning; reusing it avoids rewriting matching rows.
- Plural-noun keys map cleanly to collection-context display labels (`"Food" / "Drinks" / "Stays" / "Sights" / "Activities" / "Shops"`, used wherever a category is referenced as a group — future filter pills, future grouped lists).
- Singular instance-context labels (used today on the triage card per the existing pattern — see UI section) are derived from a small map: `food → Food`, `drinks → Drink`, `stays → Stay`, `sights → Sight`, `activities → Activity`, `shops → Shop`. Trivial dictionary, lives next to the icon map.

**Six buckets, not four or seven.** Four (`Food / Stay / Explore / Shop`) keeps a junk drawer ("Explore" absorbing museums + hikes + viewpoints + neighborhoods). Seven (adding `Coffee` as its own split) is the right move only once we see the data justify it. Six is the split that meaningfully changes the icon grid without over-fragmenting the eventual filter pills.

**Legacy `'activity'` rewrites to `'activities'`.** Single one-shot UPDATE in the migration. `'food'` stays. `'place'` rewrites to `NULL` (the existing fallback path in `PlaceTile` and friends already handles NULL → generic pin icon). The `'place'` bucket was a junk drawer; mapping it to any of the new six would be wrong more often than right.

**LLM gets one-line per-bucket guidance, not exhaustive examples.** The current prompt names a handful of examples per category and the LLM extrapolates correctly. We keep that style and don't try to enumerate every Google type:

```
- category: one of:
    "food"       — restaurants, cafés, bakeries, food markets, food halls
    "drinks"     — bars, cocktail lounges, breweries, wineries, nightlife
    "stays"      — hotels, hostels, ryokans, guesthouses, vacation rentals
    "sights"     — landmarks, viewpoints, museums, galleries, neighborhoods, parks
    "activities" — hikes, tours, classes, experiences, day-trips, surf spots
    "shops"      — boutiques, malls, souvenir markets, bookstores
```

Edge cases the LLM will resolve case-by-case (and we accept the call):
- A café that's also a bar at night → `food` (primary daytime intent wins; subtype work in follow-up B captures the rest).
- A museum gift shop named as the place itself → `shops`; a museum that mentions its gift shop in passing → `sights`.
- A food market that's also a tourist sight (e.g. Tsukiji Outer Market) → `food` (the LLM has been calling these `food` already; consistent).

**Re-extraction does not re-categorise existing rows.** The existing extractor matches against `findSoleMatchByNormalizedKey` before inserting; on a hit, it asymmetric-fills NULL columns from the new extraction. Asymmetric-fill on `category` is a behavior question worth being explicit about: a new `'shops'` extraction landing on a row currently categorised `'food'` should *not* silently overwrite. Decision: **`category` is asymmetric-fill** (NULL → new value; non-NULL preserved). Same rule the other extraction-time columns follow today.

**Icons chosen for the six buckets** (SF Symbols, with iOS-version baseline noted):

| Stored value | Label | Icon | Available since |
|---|---|---|---|
| `food` | Food | `fork.knife` | iOS 14 |
| `drinks` | Drinks | `wineglass` | iOS 16 |
| `stays` | Stays | `bed.double` | iOS 14 |
| `sights` | Sights | `binoculars` | iOS 14 |
| `activities` | Activities | `figure.hiking` | iOS 16 |
| `shops` | Shops | `bag` | iOS 13 |

All six are stock SF Symbols, available on the project's minimum iOS target (iOS 17+, set by Expo 55). No custom SF Symbol assets.

The `null`-category fallback stays `mappin.circle` — used for legacy `'place'` rows post-migration and any pre-enrichment row where the LLM emitted `null`.

## Data flow

```
source captured → OCR → extraction
  → LLM emits {name, city, address, category, country_code} per place
    where category ∈ {food, drinks, stays, sights, activities, shops}
  → existing dedup + insert path unchanged
  → places.category stored as the LLM's value
```

Enrichment (Google Places) is unchanged for now. It writes `name`, `city`, `formatted_address`, `latitude`, `longitude`, `photo_name`, `description`, `rating`, `price_level`, `external_place_id`, `external_url`, `country_code`. It does **not** touch `category`; the LLM's bucket sticks.

(Future work in spec B will let enrichment also write a `place_types` array as a subtype, with the bucket label still LLM-driven.)

## Migrations

Two migrations, in order. Both run inside the standard migration transaction, no FK toggling.

**`0008_category_rename`** — rewrite legacy `places.category` values:

```sql
UPDATE places SET category = 'activities' WHERE category = 'activity';
UPDATE places SET category = NULL         WHERE category = 'place';
-- 'food' rows keep their value (meaning unchanged).
```

Idempotent on a re-run (the `WHERE` filters miss after the first pass). No table rebuild.

**`0009_drop_tags`** — drop the `tags` table and rebuild the `sources_fts` triggers to stop referencing it:

```sql
-- Drop the triggers first; sources_fts_ai / _au reference the tags table
-- via a subquery and would error if we dropped the table first.
DROP TRIGGER IF EXISTS sources_fts_ai;
DROP TRIGGER IF EXISTS sources_fts_au;
DROP TRIGGER IF EXISTS sources_fts_ad;

DROP TABLE IF EXISTS tags;

-- Re-create the triggers without the tags subquery. sources_fts content
-- becomes: ocr_text + parent trip name. (Tag values previously concatenated
-- in here are gone; there were never any rows.)
CREATE TRIGGER sources_fts_ai
AFTER INSERT ON sources
BEGIN
  INSERT INTO sources_fts (source_id, content)
    SELECT NEW.id,
           coalesce(NEW.ocr_text, '') ||
           coalesce(' ' || (SELECT name FROM trips WHERE id = NEW.trip_id), '');
END;

CREATE TRIGGER sources_fts_au
AFTER UPDATE OF ocr_text, trip_id ON sources
BEGIN
  DELETE FROM sources_fts WHERE source_id = OLD.id;
  INSERT INTO sources_fts (source_id, content)
    SELECT NEW.id,
           coalesce(NEW.ocr_text, '') ||
           coalesce(' ' || (SELECT name FROM trips WHERE id = NEW.trip_id), '');
END;

CREATE TRIGGER sources_fts_ad
AFTER DELETE ON sources
BEGIN
  DELETE FROM sources_fts WHERE source_id = OLD.id;
END;
```

`sources_fts_ad` doesn't reference `tags`, but it's dropped and recreated for symmetry — the three triggers are a coherent set and reading them later is easier when they all live in the same migration.

Existing `sources_fts` rows are not rebuilt. The tags subquery in the old triggers always returned empty (no rows in `tags`), so the FTS content is bit-for-bit identical to what the new triggers will produce. A future re-index isn't necessary.

**TypeScript cascade-delete cleanup** (lands in the same change-set as `0009_drop_tags`):

- `modules/storage/trips.ts:150-153` — drop the `DELETE FROM tags WHERE source_id IN …` line (and the leading "tags first" mention in the surrounding comment).
- `modules/storage/sources.ts:308` — drop `await db.runAsync(\`DELETE FROM tags WHERE source_id = ?\`, id);`.
- `modules/storage/places.ts:256` — drop `await db.runAsync(\`DELETE FROM tags WHERE source_id = ?\`, sourceId);`.

These are safe to remove only after `0009_drop_tags` runs. The migration runs at app boot before any storage call, so a single release shipping both the migration and the TS removal is atomic from the user's perspective.

Pre-2026-05-15 dev DBs follow the same migration path — devs do not need to wipe.

## UI changes

**`components/PlaceTile.tsx`** — replace `CATEGORY_ICON` map (currently 3 entries) with the 6-entry map above. Type `category: 'food' | 'drinks' | 'stays' | 'sights' | 'activities' | 'shops' | null`.

**New behaviour: the icon also shows on the bottom overlay** whenever `category !== null`, prefixing the secondary line:

```
┌──────────────────┐
│  [photo]         │
│                  │
│                  │
│  Maru Tonkatsu   │   ← name (13pt, bold, white)
│  🍴 Tokyo · ★4.5 │   ← icon + city/rating (11pt, white-85%)
└──────────────────┘
```

Rendering rules:

- Render the secondary line whenever `category != null` OR `city` OR `rating` is set (today's condition is `city || rating`).
- Icon sits inline at the start of the line, 11pt, `tintColor = 'rgba(255,255,255,0.85)'` (matches the text colour), wrapped in the same text-shadow values as the name to stay readable on bright photos.
- Spacing: 4pt gap between the icon and whatever follows. If the rest of the line is empty (no city, no rating), the icon stands alone on the bottom-left.
- For legacy rows with `category = null` (post-migration `'place'` rows), no icon is shown — the line falls back to its old `city ?? '' + rating` content, exactly as today.

Layout switches from a single `<Text>` to a flex-row container holding `<Icon>` + `<Text>`. The text-shadow that today is set on the secondary `<Text>` directly migrates to the Icon (`shadowColor` on the wrapping View) and stays on the text.

`accessibilityHint` on the tile is extended to include the category: `"<Food | Drinks | Stays | …> in <city>. Opens place detail."` when both are present, gracefully degrading when one is missing. The icon itself is `accessibilityElementsHidden` since the hint already conveys the same information in words.

Visual rationale for inline-prefix over a top-right floating chip:

- Top-right would compete with the TripChip at top-left when both render on the global feed — two floating chips on a small square tile is busy.
- Inline-prefix piggybacks on the existing overlay; no new positioned element, no new gradient mask to tune.
- The icon at 11pt next to 11pt text reads cleanly and stays out of the photo's focal area.

**`components/PlaceRow.tsx`** — same map and type update. Row already shows the icon at 20pt next to the place name; no layout change.

**`app/triage.tsx`** — `CATEGORY_ICON` and the singular-instance label dictionary (currently `'food' → 'Restaurant'`, `'activity' → 'Activity'`) updated to:

```ts
const CATEGORY_LABEL = {
  food: 'Food',
  drinks: 'Drink',
  stays: 'Stay',
  sights: 'Sight',
  activities: 'Activity',
  shops: 'Shop',
} as const;
```

(Singular at the triage-card site because each card represents one extracted place — matches the existing pattern that mapped `'food' → 'Restaurant'`, `'activity' → 'Activity'`. The plural-noun storage key drives the collection-context label elsewhere.)

**`components/onboarding/DemoPlaceCard.tsx`** — same icon-map update. The onboarding demo fixtures (`onboarding_screen_content.md` memory) currently use the 3-cat values; they get rewritten in this change so the demo shows the new icons.

## Worker prompt + schema

`workers/extract-proxy/src/prompt.ts` — `SYSTEM_PROMPT` category bullet replaced with the six-bucket version above. `GEMINI_RESPONSE_SCHEMA.properties.places.items.properties.category.enum` becomes `['food', 'drinks', 'stays', 'sights', 'activities', 'shops']`.

`workers/extract-proxy/src/schema.ts` — `placeSchema.category` enum updated to the same six values.

Gemini's structured-output guarantee means a payload that fails the Zod parse is a real schema drift, same as today.

## Client schema

`modules/extraction/proxy.ts` — `placeSchema.category` Zod enum updated to the six values. `modules/extraction/extraction.ts` — `ExtractedPlaceInput.category` literal-union updated. `modules/storage/places.ts` keeps `category: string | null` at the storage layer (already permissive — Zod is upstream).

## Testing

- Worker: unit tests for the new enum on `placeSchema`; an end-to-end test that the Gemini schema includes the six values; a snapshot of `SYSTEM_PROMPT` so future edits are intentional.
- Client extraction: existing tests update to use new category values; new test that an unknown category from the proxy is rejected by Zod and surfaced as an extraction failure.
- Migration `0008_category_rename`: tests in `modules/storage/migrations/__tests__/` covering `'activity' → 'activities'`, `'place' → NULL`, `'food'` left alone, idempotent re-run.
- Migration `0009_drop_tags`: test that the `tags` table no longer exists after migration; test that `sources_fts` content for a source with `ocr_text` + a trip is correct after the trigger rebuild (one INSERT, one UPDATE OF ocr_text, one UPDATE OF trip_id); test that source DELETE still cleans the FTS row.
- Storage cascade: existing delete tests in `trips.ts`/`sources.ts`/`places.ts` updated to no longer expect a `DELETE FROM tags` call.
- UI: snapshot or render test on each of `PlaceTile`, `PlaceRow`, triage card for each of the six categories rendering the correct icon. Not exhaustive — one render per category is enough. For `PlaceTile`, also cover the new overlay-icon cases: `(category, city, rating)`, `(category, city)`, `(category, rating)`, `(category alone)`, `(no category, city only)` — five permutations confirming the line renders / hides correctly and the icon appears when expected.
- No new test suite needed for filter pills (out of scope).

## Risks / open questions

- **"Drinks" vs "Food" overlap on cafés-that-become-bars.** Accepted; primary daytime intent wins. The eventual subtype work makes this a non-issue.
- **`'sights'` is a noun-form some users may read as "tourist traps."** Considered alternatives: `'places'` (clashes with the legacy junk-drawer term and the `places` table name), `'landmarks'` (too narrow — excludes neighborhoods, parks), `'attractions'` (theme-park energy). `'sights'` is the least bad.
- **Re-running extraction on a row already categorised as `'food'` could in principle return `'shops'` for a food market that's mainly a tourist sight.** Asymmetric-fill protects the row (non-NULL preserved). The user has no UI to override the category; if it becomes a real complaint, a manual override field is a small follow-up.
- **`'place'` rows post-migration have no icon-derived bucket.** They render with the generic pin icon and are invisible to any future category-filter pill. We accept this; they're old rows from a junk-drawer category and will age out as the user adds new places.
