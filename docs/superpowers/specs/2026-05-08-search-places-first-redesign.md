# Search — Places-First Refit + Redesign

**Date:** 2026-05-08
**Status:** ready for review
**Roadmap:** v0.2. Replaces the source-centric search shipped under `2026-05-07-ocr-and-search-design.md` after the places-first restructure (`2026-05-08-places-first-restructure-design.md`) and the Sea+Teal redesign.

## Goal

The search screen should match the rest of the app: places-first results, redesign tokens, and actually return hits when the user types text they remember from a captured screenshot.

After this ships, tapping the magnifier from Pocket home or trip detail opens a search screen where typing a fragment of any indexed place text — name, city, description, OCR fragment attributed during extraction, or extracted address — surfaces matching **places** in a compact list. Tapping a place opens its detail screen.

## Non-goals

- **Source/screenshot results.** Sources without a parent place stay invisible to search. Most travel screenshots produce at least one extracted place; orphan sources are an Inbox concern. Re-evaluate if real dogfooding shows the gap bites.
- **Tag-based filtering UI.** The schema indexes tag `value` strings inside `sources_fts`, but tag CRUD UI doesn't exist yet (separate v0.2 item). Once it lands, places search expands its FTS doc — out of scope here.
- **Pagination, search history, recent queries, suggestions.** 50-row hard cap covers the v0.2 dataset.
- **Cross-language transliteration.** What `places_fts` indexes is what matches.
- **Snippet/excerpt highlighting in result rows.** The chosen layout (option A — compact) doesn't show a snippet, so we don't render `snippet()` output. The FTS query still returns rank for ordering.
- **Re-architecting the FTS triggers.** They already produce the right document for places (`name + city + description + place_sources.raw_text + place_sources.extracted_address`) — we just point search at `places_fts` instead of `sources_fts`.

## Context

What's in the codebase today:

- `app/search.tsx` — predates the restructure and the redesign. Queries `sources_fts`, opens `/sources/[id]` on tap. Uses hardcoded slate/white classes (`bg-white`, `text-slate-900`, `bg-slate-100`) instead of the redesign's semantic tokens (`bg-bg`, `text-text-muted`, `bg-surface`, etc., per `app/(tabs)/(places)/index.tsx:116`).
- `modules/search/buildFtsMatch.ts` — generic FTS5 escaper that already documents itself as usable against `sources_fts` _or_ `places_fts`. Reuse as-is.
- `modules/storage/migrations/0001_init.ts` — declares `places_fts` with `tokenize='trigram'` and triggers that keep its content as `name + city + description + GROUP_CONCAT(place_sources.raw_text, 2KB-capped) + GROUP_CONCAT(place_sources.extracted_address)`. Triggers fire on places insert/update, place_sources insert/update/delete, and places delete.
- `components/SearchButton.tsx` — magnifier button used in Pocket home (`app/(tabs)/(places)/index.tsx:98`) and trip detail (`app/trips/[id].tsx:100`). Always pushes `/search` with no params.
- `components/PlaceTile.tsx` and the styling tokens it uses — the visual model the result row should match.

The user reports two problems: layout is broken (pre-redesign tokens) and "doesn't even work" (no results). The first is a styling refit; the second is most likely **wrong index**: the user is typing place names which live in `places_fts`, not in `sources_fts`. After the refit lands, this should be observable: place-name queries return results immediately. If they don't, see "Verifying FTS state" below.

## Design

### Result model

Search queries `places_fts MATCH ?` only. Every row in the result list is a place.

The trip filter narrows to places whose `places.trip_id` matches the selected chip. "All trips" leaves it open and also includes places with `trip_id IS NULL` (places extracted from sources still in Inbox).

```sql
SELECT p.id          AS id,
       p.name        AS name,
       p.city        AS city,
       p.category    AS category,
       p.photo_name  AS photo_name,
       p.trip_id     AS trip_id,
       t.name        AS trip_name
  FROM places_fts
  JOIN places p ON p.id = places_fts.place_id
  LEFT JOIN trips t ON t.id = p.trip_id AND t.deleted_at IS NULL
 WHERE places_fts MATCH ?
   AND p.deleted_at IS NULL
   AND (? IS NULL OR p.trip_id = ?)
ORDER BY rank
 LIMIT 50;
```

Bound params, in order: `[match, tripFilter, tripFilter]`. `tripFilter` is repeated to keep all binds positional (matches the existing search-screen style; `?N`-numbered params are avoided).

`useLiveQuery` change-deps: `['places', 'trips', 'place_sources']`. `place_sources` is included so a newly-extracted source whose place becomes searchable mid-session re-runs the query without manual reload.

### Result row — option A (compact)

Picked from the visual companion. Per row, a single horizontal line:

- **Left:** 64×64 rounded thumbnail. Shows the enriched place photo if `photo_name` is set; otherwise the same placeholder treatment `PlaceTile` already uses, so search and home stay visually consistent.
- **Right (stacked):**
  - **Line 1:** place name (`text-base font-semibold text-text`).
  - **Line 2:** chip row — trip chip ("Inbox" if `trip_id IS NULL`) and category chip when `category` is non-null. Chips reuse `TripChip` and `CategoryChip` so styling stays single-source-of-truth.

No matched-text snippet. No subtitle line for `city` — if it earns its keep in dogfood, it can come back as a third line, but option A explicitly trades that off for density.

Tap → `router.push('/places/${item.id}')`.

### Header

Keep the current pattern: native nav header with `headerLeft` "Cancel" and a `TextInput` filling `headerTitle`. The only change is styling — replace hardcoded slates with redesign tokens (`bg-surface`, `text-text`, `placeholder:text-text-muted`, focus ring matching the rest of the app's input affordances). Autofocus on mount, `clearButtonMode="while-editing"`, `returnKeyType="search"` — unchanged.

### Trip filter chips — smart default

Today the search route is invoked the same way from anywhere; the launching screen is implicit. We make it explicit by adding a router param:

```ts
// SearchButton.tsx
type Props = { tripId?: string };
router.push({ pathname: '/search', params: tripId ? { trip: tripId } : {} });
```

In `app/search.tsx`, read `useLocalSearchParams()` and seed `tripFilter` with `params.trip ?? null` on first render. After that, the user's chip taps own the state.

The chip row stays: "All trips" + each non-deleted trip alphabetically. Selected styling uses the redesign's primary token (Teal). Hidden when there are zero trips.

### States

| Condition                             | UI                                                                                                                                |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `input.trim() === ''`                 | Centered hint "Search your places" (was "Search your screenshots").                                                               |
| `match === null && trim.length > 0`   | Centered "Type at least 3 characters". (Trigram minimum, unchanged.)                                                              |
| `rows === null` (loading first frame) | Render nothing — `useLiveQuery` resolves quickly enough that a spinner is more distracting than helpful for a 50-row LIMIT query. |
| `rows.length === 0`                   | Centered "No places match '<query>'". Uses `text-text-muted`.                                                                     |
| `rows.length > 0`                     | `FlatList` of result rows, ranked, capped at 50.                                                                                  |

All copy uses redesign typography tokens (`text-base text-text-muted` for hints) and lands inside a `bg-bg` flex container so dark mode falls out for free.

### Verifying FTS state (debugging the "no results" report)

Before merging, verify in a dev build (Sim or device) that `places_fts` actually contains rows with the expected content. The plan should include a one-time debug step:

1. Boot the app with at least one trip, one screenshot, OCR done, place extracted.
2. Via a temporary log (or expo-sqlite SQL inspector) run, in order:
   - `SELECT count(*) FROM places_fts;` — expect > 0.
   - `SELECT substr(content, 1, 80) FROM places_fts LIMIT 5;` — expect place name and OCR fragment in each sampled row.

   Run as two queries — combining them as `SELECT count(*), substr(content, 1, 80) FROM places_fts LIMIT 5` returns a single aggregate row with an undefined `content` value, not five samples.

3. If empty, the bug is upstream — extraction isn't reaching the `place_sources` insert (which is what fires the rebuild trigger that adds `raw_text` to the FTS doc). That would be a separate spec/fix; flag it in the implementation plan rather than swallowing it here.

If `places_fts` is populated but the screen still returns nothing, the bug is in the query or in `useLiveQuery`'s change-deps. The new query above plus the new deps (`['places', 'trips', 'place_sources']`) should resolve it; if not, add a temporary direct `db.getAllAsync` log path to compare.

## Components

### `app/search.tsx` — restructured

Same file, materially rewritten:

- New `SEARCH_SQL` (places-first, see above).
- `ResultRow` type changes from `{id, file_path, trip_id, trip_name, snippet}` to `{id, name, city, category, photo_name, trip_id, trip_name}`. `SearchSnippet` import removed (no snippet rendering).
- `tripFilter` state seeded from `useLocalSearchParams().trip`.
- `useLiveQuery` change-deps widen to `['places', 'trips', 'place_sources']`.
- All `bg-white`/`bg-slate-*`/`text-slate-*` classes swap to redesign tokens. Spacing follows existing screens (`px-4`, `py-2`, `gap-3`).
- Tap target → `/places/[id]`.

### `components/SearchButton.tsx` — accept optional `tripId`

```ts
export function SearchButton({ tripId }: { tripId?: string }) {
  const router = useRouter();
  return (
    <Pressable
      onPress={() => router.push({
        pathname: '/search' as Href,
        params: tripId ? { trip: tripId } : {},
      })}
      ...
    >
      <MagnifyingGlassIcon />
    </Pressable>
  );
}
```

Pocket home (`app/(tabs)/(places)/index.tsx`) renders `<SearchButton />` (unchanged). Trip detail (`app/trips/[id].tsx`) renders `<SearchButton tripId={trip.id} />`.

### `components/TripChip.tsx` — new (extract)

A trip-name pill currently inlined in two places: `components/PlaceTile.tsx:79-92` (white-translucent variant overlaid on the photo) and `app/search.tsx`'s local `Chip` (slate-on-slate variant in the filter row). The new component takes a `name` and a `variant: 'overlay' | 'inline'`, encapsulating both treatments. Both existing call sites move to use it. The search result row uses `variant='inline'`.

### `components/CategoryChip.tsx` — new (extract)

`app/places/[id].tsx:388` declares `CategoryChip` as a private function inside the screen. Move it to `components/`, export it, and replace the inline reference with an import. The search result row imports from the same location.

### `components/SearchResultRow.tsx` — new

Pulled out of `app/search.tsx` so the screen stays focused on layout/state. Renders the option-A row. Composes `TripChip` (with `'Inbox'` text when `trip_id IS NULL`) and `CategoryChip` from the two extractions above.

### Removals

- `components/SearchSnippet.tsx` — no longer used by `app/search.tsx`. Delete unless another caller surfaces during implementation.

## Data flow

```
  Pocket home / Trip detail
        │ tap magnifier
        │ (trip detail passes tripId param)
        ▼
  app/search.tsx
   ├─ TextInput (autofocus)
   ├─ Trip chips (preselected from params.trip when present)
   └─ FlatList of place rows
        │
        │ query: places_fts MATCH ? + trip filter
        │ deps: ['places', 'trips', 'place_sources']
        │ row: photo + name + chips
        │
        │ tap result
        ▼
  app/places/[id].tsx
```

## File-change inventory

**Modified:**

- `app/search.tsx` — rewritten per Components above. Drops its local `Chip` in favor of `<TripChip variant="inline">`.
- `components/SearchButton.tsx` — accept `tripId` prop, push with param.
- `components/PlaceTile.tsx` — replace inlined trip chip (lines 79–92) with `<TripChip variant="overlay" name={place.trip_name} />`.
- `app/places/[id].tsx` — replace local `CategoryChip` definition + reference with an import from `components/CategoryChip`.
- `app/trips/[id].tsx` — pass `tripId` to `<SearchButton>`.

**New:**

- `components/TripChip.tsx` — extracted from `PlaceTile` and `search.tsx`, with `variant: 'overlay' | 'inline'`.
- `components/CategoryChip.tsx` — extracted from the private function in `app/places/[id].tsx`.
- `components/SearchResultRow.tsx` — pulled-out row component.

**Deleted:**

- `components/SearchSnippet.tsx` — only if no other caller exists at implementation time.

**Untouched (verified during exploration, listed so we don't accidentally re-spec them):**

- `modules/search/buildFtsMatch.ts` — keep as-is.
- `modules/storage/migrations/0001_init.ts` — `places_fts` triggers already produce the right document.
- `app/(tabs)/(places)/index.tsx` — `<SearchButton />` call is correct (no `tripId`).

## Testing

**Unit (Jest, `app/__tests__/searchQuery.test.ts` or similar):**

- Empty/whitespace input → `buildFtsMatch` returns null, no query issued.
- 1- or 2-char input → `buildFtsMatch` returns null.
- Single token → `'"tok"'`.
- Multiple tokens → space-separated quoted tokens.
- CJK substring (e.g. `定食`) — verifies the trigram path still works post-refit.

**Integration (`modules/search/__tests__/search-integration.test.ts` — exists; extend rather than replace):**

- Insert a place + place_source with known `raw_text`. Query `places_fts MATCH '"tonk"'` → returns the place row with rank > 0.
- Insert two places in different trips. Query without trip filter → both. With trip filter → only matching trip.
- `trip_id IS NULL` place (extracted from un-triaged source) is included when filter is "All trips" and excluded when filter is a specific trip.
- Soft-delete the place → no longer returned.
- Update place description → next query reflects the new content (trigger fires).
- Insert a new place_source against an existing place → next query reflects the new raw_text (rebuild trigger fires).

**Manual on device:**

- Type a place name from a recently-captured screenshot — appears as the top result.
- Type an OCR fragment that's _not_ a place name but appears in the screenshot's text — appears (because `place_sources.raw_text` includes the matching span).
- Type something that isn't anywhere in places_fts — "No places match …".
- Launch search from a trip detail — the trip chip is preselected; all results are from that trip.
- Launch search from Pocket home — "All trips" chip selected.
- Toggle dark mode mid-session — colors flip via the redesign tokens.

## Open questions / decisions made

| Question                      | Decision                                                                     |
| ----------------------------- | ---------------------------------------------------------------------------- |
| Result model post-restructure | Places only. Orphan sources hidden. (User chose this.)                       |
| Result row layout             | Option A — compact (photo + name + chips, no snippet). (User chose this.)    |
| Trip filter chips             | Keep, with smart default. (User chose this.)                                 |
| Snippet highlighting          | Removed — option A doesn't show a snippet.                                   |
| Empty/zero/short copy         | "Search your places" / "Type at least 3 characters" / "No places match '…'". |
| Search header pattern         | Keep `TextInput` in `headerTitle`.                                           |
| Tap target                    | `/places/[id]`.                                                              |
| Index source                  | `places_fts`. `sources_fts` is no longer queried by the search screen.       |
| Min query length              | 3 codepoints — unchanged (trigram floor).                                    |
| Result cap                    | 50, no pagination — unchanged.                                               |

Deferred:

- Tag chip / tag filter on search — gated on tag CRUD UI shipping.
- Snippet/excerpt highlighting — comes back if compact layout proves too lean in dogfood.
- Orphan-source results — comes back if dogfood shows the gap.
- Result grouping by trip / category — not needed at v0.2 dataset size.

## Implementation order (for the plan)

1. Verify `places_fts` is populated on a real dev DB (the "doesn't work" debugging step above). If empty, file separate fix and stop.
2. Extract `components/TripChip.tsx` (with `variant`) and migrate `PlaceTile` + `search.tsx`'s local `Chip` to use it. No behavior change.
3. Extract `components/CategoryChip.tsx` from `app/places/[id].tsx` and migrate the call site to import. No behavior change.
4. Extend integration test in `modules/search/__tests__/search-integration.test.ts` for places-first queries (red).
5. Rewrite `SEARCH_SQL` + `ResultRow` + `useLiveQuery` deps in `app/search.tsx` (green).
6. Add `tripId` param to `SearchButton` + read `params.trip` in search screen.
7. Pull `SearchResultRow` out, composing the new `TripChip` + `CategoryChip`.
8. Migrate styling to redesign tokens. Verify in light + dark mode.
9. Delete `components/SearchSnippet.tsx` if unused.
10. Manual smoke on device per Testing.
