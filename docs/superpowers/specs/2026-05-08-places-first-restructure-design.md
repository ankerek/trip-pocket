# Places-first restructure — design

**Status:** v0.2 scope, design locked. Sequenced after place enrichment landing — this is the next milestone in v0.2.
**Driver:** "Make the _place_ the primary thing in the app — not the screenshot it came from."
**Date:** 2026-05-08.

## Context

v0.2 currently treats the screenshot as the primary content type. Trips contain screenshots; extracted places hang off screenshots and are deduped only at view time inside a per-trip "Places" tab. That made sense while extraction was a thin bonus on top of a screenshot-organising app — but with enrichment in (real photo, blurb, rating, coords), the _place_ is now the thing the user actually wants to scroll through, open, and use. The screenshot is just the receipt of where the place came from.

This restructure inverts the model:

- A **source** (screenshot today; Instagram post, pasted URL, etc. later) extracts to N places.
- A **place** is canonical (one row per real-world venue) and carries its own trip assignment, its own photo and metadata, and links back to the source(s) it came from.
- Trips contain **places**, not screenshots.
- The primary scrolling experience is a **global places feed**; trips are a secondary organisational tab.

It also generalises the "source" concept now so the future Instagram/URL ingestion path lands in an existing slot instead of forcing another rename.

## Decisions

| Decision                            | Choice                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Reasoning                                                                                                                                                                                                                                                                                                               |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Capture flow**                    | Hybrid: source picks a trip on capture; places are independently movable afterwards.                                                                                                                                                                                                                                                                                                                                                                                          | Today's share-sheet trip-picker is fast and right — capture stays the same. But once a place is canonical, the user must be able to move/copy/unassign it without dragging the whole source.                                                                                                                            |
| **Place identity**                  | Canonical Place with multiple sources attached.                                                                                                                                                                                                                                                                                                                                                                                                                               | Two screenshots of the same venue should be one place card with two source thumbnails, not two near-duplicate tiles in the feed. The existing `place_enrichments` table already does venue-level dedup, so the plumbing is half-built.                                                                                  |
| **Sources with 0 extracted places** | Manual sources (share-sheet, camera-roll picker) render as a "no-place" tile. Auto-detect sources (v1.x) are filtered silently per the existing roadmap classifier.                                                                                                                                                                                                                                                                                                           | The user actively put a manual source in the app — never silently hide it. The v1.x auto-detect already plans to use 0-place results as a noise classifier; that stays.                                                                                                                                                 |
| **Information architecture**        | Tabs: **Places** (global feed) · **Trips** (list → trip detail) · **Settings**.                                                                                                                                                                                                                                                                                                                                                                                               | The user's primary action is "scroll places I've saved." A global feed across trips makes that one tap. Trips remain for organisation, not for browsing.                                                                                                                                                                |
| **Untriaged places**                | Visible in the Places feed (no trip assignment required). Filter chip `Untriaged` isolates them.                                                                                                                                                                                                                                                                                                                                                                              | Forcing trip-assignment on every place re-introduces the friction the share-sheet trip-picker already solves; allowing an unassigned state matches "places freely movable."                                                                                                                                             |
| **Untriaged sources**               | Blend into the Places feed as pending/no-place tiles, distinguishable by visual treatment. Filter chip `Sources` isolates them.                                                                                                                                                                                                                                                                                                                                               | Sources are infrastructure, not first-class content. A separate `Sources` tab promotes them too aggressively; a banner on top of the feed steals visual weight. Tile-with-different-treatment keeps them ambient.                                                                                                       |
| **Place detail layout**             | Hero photo, name + city + rating, primary actions, description, metadata block, sources strip at the bottom.                                                                                                                                                                                                                                                                                                                                                                  | Place is the protagonist; the source is a footnote that says "in case you want to remember where you saw this."                                                                                                                                                                                                         |
| **Trip detail layout**              | 2-col tiles with name overlay; filter chips for tag categories and `Sources`.                                                                                                                                                                                                                                                                                                                                                                                                 | Photo-forward, scannable, room for the place name without tap-to-reveal. Matches the "Pinterest board" feel from PRODUCT.md without going to a 3-col density that drops names.                                                                                                                                          |
| **Source schema**                   | Generalise now: rename `screenshots` → `sources`, add `kind` and `url` columns. Today only `kind='screenshot'`.                                                                                                                                                                                                                                                                                                                                                               | Every place's `source_id` is then stable forever. Avoids a second rename when Instagram-post ingestion lands. The cost is one extra column today.                                                                                                                                                                       |
| **Place schema**                    | Single `places` table merging extraction + enrichment fields. **Drop** `place_enrichments` and `extracted_places`.                                                                                                                                                                                                                                                                                                                                                            | Once canonical Place is the dedup unit, the venue-keyed enrichment table degenerates to a 1:1 join. Folding it in eliminates a join from the Place detail screen and removes a class of "is this the enriched row or the extraction row?" confusion.                                                                    |
| **Place ↔ source relationship**     | Many-to-many junction table `place_sources(place_id, source_id, …)`, with the same `owner_id` / `created_at` / `updated_at` / `deleted_at` columns as the rest of the syncable schema.                                                                                                                                                                                                                                                                                        | Many sources can extract to one place (the whole point of canonical identity); a single source can extract to many places (already true today). The junction is itself a syncable row per ARCHITECTURE.md, so it carries the standard four columns.                                                                     |
| **Pre-enrichment dedup**            | `normalized_key` is a **non-unique INDEX**, not a UNIQUE constraint. Extraction merges into an existing place only when the new candidate matches _exactly one_ live place by `(normalized_key, owner_id)`. Zero or multiple matches → create a new place.                                                                                                                                                                                                                    | Same-name chains (Starbucks in Tokyo) must not silently collapse before enrichment confirms identity. Sole-match merge captures the obvious cases (re-screenshotting the same Kosoan once) without fabricating false equivalences. Real duplicates that slip through are absorbed at the enrichment merge below.        |
| **Post-enrichment merge**           | `UNIQUE(external_place_id, owner_id) WHERE external_place_id IS NOT NULL AND deleted_at IS NULL`. When a place's resolved `external_place_id` collides with an existing live place, merge **only if** their `trip_id`s are equal or one side is NULL; otherwise leave as separate places and surface a "looks like duplicate" hint in the UI later. Junction-row moves use `INSERT … ON CONFLICT DO NOTHING` so a single source linked to both sides doesn't crash the merge. | Two places with different name spellings resolving to the same Google venue must converge — but not at the cost of a user's intentional `trip_id` choice. The trip-equality constraint preserves user state; the junction `ON CONFLICT` clause prevents PK collisions when both sides already attached the same source. |
| **Migration**                       | Forward-only single migration (`0006_places_first.ts`). No down migration. Dev/internal databases should be backed up before running.                                                                                                                                                                                                                                                                                                                                         | No production users — v0.3 TestFlight has not started per ROADMAP.md. Cleaner schema is worth the one-time SQL. The destructive drops (three tables) warrant an explicit backup step on the few existing dev DBs.                                                                                                       |

## Data model

All UUIDs, all client-generated. Every syncable table keeps `created_at`, `updated_at`, `deleted_at`, `owner_id` per the existing forward-proofing rules in ARCHITECTURE.md.

### `sources`

Renamed and extended from today's `screenshots`. The semantic unit is "a thing the user fed into the app that may produce places."

```sql
id                 TEXT PRIMARY KEY NOT NULL
kind               TEXT NOT NULL                  -- 'screenshot' (today); future: 'url', 'pasted'
trip_id            TEXT NULL                       -- chosen at capture; NULL = no trip yet
file_path          TEXT NULL                       -- present for kind='screenshot'
url                TEXT NULL                       -- present for future URL-based kinds
content_hash       TEXT NOT NULL                   -- screenshot dedup. For URL-kind sources, the
                                                   -- canonicalisation rule (query-param stripping,
                                                   -- trailing-slash, redirect-following) is deferred
                                                   -- to the URL-ingestion change; today only
                                                   -- kind='screenshot' writes this column.
origin             TEXT NOT NULL                   -- 'share' | 'auto' | 'manual'
ocr_status         TEXT NOT NULL DEFAULT 'pending'
ocr_text           TEXT NULL
extraction_status  TEXT NOT NULL DEFAULT 'pending'
captured_at        TEXT NOT NULL
created_at, updated_at, deleted_at, owner_id
```

The `origin` rename (was `source` on `screenshots`) frees the word "source" to mean the row itself everywhere else in the codebase.

### `places`

The canonical Place. Carries both extraction-derived and enrichment-derived fields.

```sql
id                 TEXT PRIMARY KEY NOT NULL
trip_id            TEXT NULL                       -- independently movable; NULL = unassigned
name               TEXT NOT NULL
city               TEXT NULL
category           TEXT NULL
normalized_key     TEXT NOT NULL                   -- lower(trim(name)) || '|' || lower(trim(coalesce(city,'')))

-- enrichment-derived (NULL until /enrich resolves)
external_place_id  TEXT NULL
photo_name         TEXT NULL
description        TEXT NULL
rating             REAL NULL
price_level        INTEGER NULL
external_url       TEXT NULL
latitude           REAL NULL
longitude          REAL NULL
formatted_address  TEXT NULL
enrichment_status  TEXT NOT NULL DEFAULT 'pending' -- 'pending' | 'enriched' | 'not-found' | 'failed'
enriched_at        TEXT NULL
enrichment_model   TEXT NULL

created_at, updated_at, deleted_at, owner_id
```

Indexes:

- `INDEX(normalized_key, owner_id) WHERE deleted_at IS NULL` — **non-unique**. Used by extraction's sole-match dedup (see Decisions table and Key flows / Extraction).
- `UNIQUE(external_place_id, owner_id) WHERE external_place_id IS NOT NULL AND deleted_at IS NULL` — post-enrichment identity. Scoped by `owner_id` so a future multi-owner future doesn't trip on a globally-unique Google Place ID.
- `INDEX(trip_id) WHERE deleted_at IS NULL` — trip-detail and per-trip filter queries.
- `INDEX(enrichment_status) WHERE enrichment_status = 'pending' AND deleted_at IS NULL` — enrichment runner queue.

**Retry semantics for `enrichment_status`.** When a place is `'not-found'` or `'failed'`, the user can trigger a retry from place detail; that flips status back to `'pending'` and re-queues. New `place_sources` rows attached to an enriched place do **not** auto-reset enrichment — the canonical place is already resolved. New rows attached to a `'not-found'` place do auto-reset to `'pending'` once, since the new source's OCR may carry a sharper raw_text that the previous attempt lacked. This preserves the per-row retry granularity that today's `extracted_places.enrichment_status` provides, while keeping the column on the canonical row.

### `place_sources`

```sql
place_id            TEXT NOT NULL                  -- FK → places.id
source_id           TEXT NOT NULL                  -- FK → sources.id
extracted_at        TEXT NOT NULL
raw_text            TEXT NULL                      -- the OCR snippet the LLM keyed on
extracted_address   TEXT NULL                      -- per-source OCR-extracted street address;
                                                   -- /enrich uses the most recent non-null value
confidence          REAL NULL
extraction_model    TEXT NOT NULL
created_at          TEXT NOT NULL
updated_at          TEXT NOT NULL
deleted_at          TEXT NULL                      -- soft delete; the partial unique index below
                                                   -- treats deleted rows as absent
owner_id            TEXT NOT NULL
PRIMARY KEY (place_id, source_id)
```

Index on `source_id` for "places extracted from this source."

This table replaces every per-source field that lived on `extracted_places`. It is the _only_ path between a place and the screenshot/URL it came from. The four trailing columns match the syncable-table rule from ARCHITECTURE.md so the junction is sync-eligible later. `extracted_address` carries forward the per-source address that today lives on `extracted_places` (via migration 0004) and that `/enrich` uses as a hint.

### FTS

Two FTS5 virtual tables, queried as a UNION at search time. Today's single `screenshots_fts` is replaced by:

- **`places_fts`** — one document per place: `name + city + description + concatenated place_sources.raw_text + per-source extracted_address`. Each `raw_text` contribution is capped at **2 KB** before concatenation so a hot venue saved across many sources doesn't produce an oversized FTS document. Triggers on `places` and `place_sources` maintain the document.
- **`sources_fts`** — one document per source: `ocr_text + parent trip name + tag values still keyed on the source row`. Triggers on `sources`, `trips`, and `tags` maintain the document. This keeps search coverage for source-only items (no extracted places yet, or 0-place manual sources), trip names, and the existing screenshot-keyed tags during the transition window.

Search results from both tables are merged and deduplicated in `modules/search`. The hook surface (`useSearch(query)`) is unchanged from today's consumers.

Search semantics get sharper: a query like "tonkatsu" hits the place's name, the enrichment blurb, _and_ every OCR snippet that produced that place — across multiple sources — while a query like "blurry food shot" still finds the source row even if it has no extracted places.

## Module changes

The module boundaries from ARCHITECTURE.md hold; their internal shape changes.

- `modules/storage` — new repos: `sources`, `places`, `place_sources`. Drop `extracted_places` and `place_enrichments` repos. The migration runner picks up `0006_places_first.ts`.
- `modules/extraction` — emits `places` rows + `place_sources` rows. Pre-enrichment merge runs the **sole-match rule**: `SELECT id FROM places WHERE normalized_key = ? AND owner_id = ? AND deleted_at IS NULL`; if exactly one row comes back, attach a junction row to it; if zero or multiple, create a new place. New places inherit `trip_id` from the source at creation time only.
- `modules/enrichment` — writes enrichment columns directly on the matching `places` row. On `external_place_id` collision with another live place owned by the same owner, runs the merge **only if** the trip rule is met (loser and winner have equal `trip_id`, or one is NULL). When merging, junction-row moves use `INSERT INTO place_sources … ON CONFLICT(place_id, source_id) DO NOTHING` so a single source linked to both sides doesn't error. If the trip rule fails, the new `external_place_id` is **not** written; instead a `place_duplicate_hint` row is recorded (deferred — see Out of scope) so the UI can surface a manual-merge affordance later. The merge is the only place this constraint is enforced; isolating it here keeps the rule findable.
- `modules/places` — promoted to first-class. Owns: live queries for the global feed and per-trip filter, place-detail data assembly (no longer joins; one row), `movePlaceToTrip(placeId, tripId | null)`, `unassignPlace(placeId)`, `retryEnrichment(placeId)` (resets `enrichment_status = 'pending'`), the maps deep-link helper (carried forward).
- `modules/capture` — writes `sources` rows. Trip on the source flows through to newly-created places at extraction time. Source.trip and place.trip are decoupled afterwards.
- `modules/search` — queries `places_fts` and `sources_fts` and merges results. The hook surface is unchanged.

`app/` UI layer keeps zero business logic per ARCHITECTURE.md. Screens query the modules and render.

## Navigation

| Route                          | Purpose                                                                                                                                           |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/(tabs)/(places)/index.tsx`   | Global Places feed. Filter chips: `All` / `Untriaged` / `Sources` / per-tag chips. Tap place → `/places/[id]`. Tap source-tile → `/sources/[id]`. |
| `/(tabs)/(trips)/index.tsx`    | List of trips with preview thumbnails (best photo per trip — most-recent enriched place).                                                         |
| `/trips/[id]`                  | 2-col places grid for that trip, same filter chips minus `Untriaged`.                                                                             |
| `/places/[id]`                 | Place detail: hero photo, name + city + rating, **Open in Maps**, description, metadata, sources strip.                                           |
| `/sources/[id]`                | Source detail: full screenshot view + extracted-places strip with chip nav. Replaces today's `app/places/[id].tsx` screenshot viewer.             |
| `/(tabs)/(settings)/index.tsx` | Unchanged.                                                                                                                                        |

Today's route layout has `app/places/[id].tsx` (the screenshot viewer file) sitting next to a `app/places/[id]/` folder containing helper screens (`ocr-debug.tsx`, `places-found.tsx`). Slice 1 moves the file `app/places/[id].tsx` to `app/sources/[id].tsx` verbatim — same component, new path — so `app/places/[id].tsx` is free for the new Place detail. The helper screens under `app/places/[id]/` move alongside it to `app/sources/[id]/` (they're keyed off the source-id route param today).

## Key flows

### Capture (share-sheet)

Unchanged from the user's POV. Behind the scenes: extension writes a `sources` row instead of a `screenshots` row; everything else is the same `pending_imports` → main-app → OCR → extraction → enrichment pipeline.

### Extraction

For each `{name, city, category, raw_text, extracted_address, confidence}` returned by the LLM:

1. Compute `normalized_key = lower(trim(name)) || '|' || lower(trim(coalesce(city, '')))`.
2. **Sole-match dedup.** Count live places with the same `(normalized_key, owner_id)`:
   - **0 matches** → INSERT a new place (trip_id ← source's trip_id; enrichment_status='pending').
   - **1 match** → reuse it. Do not change the existing place's `trip_id` or any other column; the existing row owns its state.
   - **≥2 matches** → INSERT a new place. The duplicates already exist; we don't want to pick arbitrarily, and the post-enrichment merge will collapse them when `external_place_id` resolves.
3. INSERT INTO `place_sources` (`place_id, source_id, extracted_at, raw_text, extracted_address, confidence, extraction_model, owner_id, created_at, updated_at`).
4. If the place was already enriched and is `'not-found'`, flip its `enrichment_status` back to `'pending'` so the next open retries with the new raw_text. Don't reset `'enriched'` places.

The source's `extraction_status` flips to `done` when all candidates have been processed. A 0-result run is also `done` — that's how a manual source becomes a "no-place" tile.

### Enrichment

When the user opens a place with `enrichment_status='pending'`:

1. Call worker `/enrich` with the place's name, city, the most recent non-null `place_sources.extracted_address`, and the most recent non-null `place_sources.raw_text` as OCR caption.
2. On success: detect collision by selecting any other live place with the same `external_place_id` and `owner_id`. If none, write enrichment columns onto the place row and flip `enrichment_status='enriched'`. Done.
3. If a collision exists (call the candidates **incoming** = the place being enriched and **existing** = the already-enriched colliding place):
   - **Merge eligibility:** allowed only if `incoming.trip_id = existing.trip_id` OR one of them is NULL. Otherwise _do not write_ `external_place_id` on incoming and leave both places live; record telemetry `place.duplicate_hint_skipped`. The UI can surface a manual-merge affordance later (out of scope for this change).
   - **Winner:** the place that already has the merged trip context. If `existing.trip_id IS NOT NULL`, existing wins. Else if `incoming.trip_id IS NOT NULL`, incoming wins. Else (both NULL) the older `created_at` wins. The winner keeps its trip; the loser is soft-deleted.
   - **Junction migration:** `INSERT INTO place_sources(place_id, source_id, …) SELECT winner.id, source_id, … FROM place_sources WHERE place_id = loser.id ON CONFLICT(place_id, source_id) DO NOTHING`. The PK conflict case (a single source linked to both sides) silently keeps the winner's existing junction row, since it carries the same `source_id` and the duplicate junction adds nothing.
   - **Enrichment columns:** if winner is _existing_ (already enriched), nothing else changes — incoming is just absorbed. If winner is _incoming_, copy enrichment columns from existing onto incoming, then soft-delete existing. The partial UNIQUE index on `external_place_id` permits this because the loser's `deleted_at` is now non-null.
4. Failure modes (`'not-found'`, network, etc.) set `enrichment_status` accordingly; the row stays usable, just not enriched. The user can retry from place detail.

### Move place between trips

`UPDATE places SET trip_id = ?` (or `NULL` to unassign). The source's `trip_id` is unchanged. Live queries refresh the feed automatically.

### Move source between trips

`UPDATE sources SET trip_id = ?`. Existing places extracted from this source stay in their current trips — the user-chosen "places freely movable" rule.

**Display rule for divergence.** A place's display location is governed _only_ by `place.trip_id`:

- `place.trip_id = T` → place tile appears in trip `T`'s grid and in the global Places feed.
- `place.trip_id IS NULL` → place appears only in the global Places feed (Untriaged filter), regardless of where its sources live.

Sources are governed only by `source.trip_id`:

- A source-only tile (manual 0-place source) follows `source.trip_id` for trip placement.
- A source whose trip differs from one of its extracted places' trip is _not_ a UI bug — the place detail's sources strip annotates the source with its own trip when it differs ("from a Lisbon source"), so the user has the breadcrumb without forcing the place to appear in two trips.

## Migration: `0006_places_first.ts`

Forward-only, single migration. Runs on next launch. The whole migration runs inside one SQLite transaction; on any error, the DB rolls back to pre-migration state.

**Pre-flight:** before applying the migration, the runner copies the current `*.sqlite` file to `*.sqlite.pre-0006.bak` in the same directory. Dev/internal databases that hit a bug can roll forward by restoring the backup and pinning the prior schema-version. The backup is deleted on the user's _next_ launch after a successful migration to avoid permanent disk overhead.

```
1. Create the new tables and indexes:
     sources, places, place_sources, places_fts, sources_fts (+ triggers).

2. Copy screenshots → sources:
     INSERT INTO sources (id, kind, trip_id, file_path, url, content_hash,
                          origin, ocr_status, ocr_text, extraction_status,
                          captured_at, created_at, updated_at, deleted_at, owner_id)
     SELECT id, 'screenshot', trip_id, file_path, NULL, content_hash,
            source AS origin, ocr_status, ocr_text, extraction_status,
            captured_at, created_at, updated_at, deleted_at, owner_id
     FROM screenshots;

3. Process extracted_places in two passes so external_place_id resolution
   happens before normalized_key fallback. Both passes share the same
   per-row work below; only the WHERE clause differs.

   Per-row work:
     - Compute normalized_key from name + city.
     - Look up the source's trip_id via screenshot_id.
     - Resolve the canonical place_id with this priority:
         a. If the row's external_place_id IS NOT NULL, SELECT a live places
            row by (external_place_id, owner_id). If found, reuse it. If a
            place is found via this branch and its existing
            external_place_id is NULL but the current row's is non-null,
            UPDATE the place to set external_place_id (this is the path
            that ensures step 4 always finds a target).
         b. Otherwise SELECT live places by (normalized_key, owner_id).
            - If exactly one row, reuse it.
            - If multiple, INSERT a new place (matches the runtime
              sole-match rule).
            - If none, INSERT a new place.
         c. New places carry: name, city, category, normalized_key,
            external_place_id (if present on the row), trip_id (from the
            source's screenshot.trip_id), enrichment_status (carried from
            the extracted_places row), enriched_at, and the standard
            owner/timestamp columns.
     - INSERT INTO place_sources(place_id, source_id, extracted_at,
       raw_text, extracted_address, confidence, extraction_model, owner_id,
       created_at, updated_at) using the resolved place_id. extracted_address
       is copied from extracted_places.address (the OCR-extracted street
       address column added by migration 0004; do not confuse with
       extracted_places.formatted_address from migration 0003, which is
       the enrichment-derived field that maps to places.formatted_address
       in step 4).

   Pass A: rows WHERE external_place_id IS NOT NULL, oldest first by
           created_at. This pass establishes canonical places keyed by
           external_place_id.
   Pass B: rows WHERE external_place_id IS NULL, oldest first.

4. For each row in place_enrichments:
     - UPDATE places SET <enrichment columns including enrichment_status,
       enriched_at, enrichment_model> WHERE external_place_id = ?.
     - If the UPDATE affects 0 rows (orphan enrichment), skip.

5. Drop indexes, FTS triggers, and tables in dependency-safe order:
   screenshots_fts (and its triggers) → extracted_places →
   place_enrichments → screenshots.

   **Deferred to a follow-up migration `0007_drop_legacy.ts`.** Migration
   0006 leaves the legacy tables in place so downstream module rewires
   (Phase B in the implementation plan) can land incrementally without
   the entire test suite going red. Once `modules/extraction`,
   `modules/enrichment`, `modules/capture`, and `modules/search` all
   read from the new schema, 0007 runs the drops plus the `tags`
   rebuild (the existing `tags.screenshot_id → screenshots(id)` FK has
   to migrate to `sources(id)`, and SQLite's automatic trigger
   schema-rewrite during `ALTER TABLE … RENAME TO tags` requires
   dropping and recreating `sources_fts_ai` / `sources_fts_au` around
   the rebuild — body unchanged).
```

Step 3 is the only step that needs care: it's read-from-old, write-to-new, with a deterministic two-pass dedup rule. Worth a smoke test on a snapshot of the dev DB before shipping.

## Phasing

The change is large enough to want a seam. Two slices, both inside v0.2:

- **Slice 1 — schema + data plumbing.** Migration, extraction/enrichment rewire, `modules/places` API, the new Place detail screen at `/places/[id]` (replacing today's `app/places/[id].tsx` screenshot viewer with a brand-new component), and the screenshot viewer relocated to `app/sources/[id].tsx` as a literal move of today's component (no UI changes — just the new path so `app/places/[id].tsx` is free for the Place detail). The helper screens currently under `app/places/[id]/` move alongside to `app/sources/[id]/`. Trip detail temporarily renders the same Places query filtered by `trip_id` (one component, two screens). Ships a working places-first model end-to-end on dev.
- **Slice 2 — UX surfaces.** Source detail upgrade (extracted-places strip + chip nav on `/sources/[id]`), filter chips on Places and Trip detail, no-place / pending tile treatments, Source thumbnail components, deletion of legacy components.

Slice 1 unblocks correctness; Slice 2 layers polish. Both ship within v0.2; v0.3 TestFlight is the gate behind both.

## Telemetry

New PostHog events (existing vocabulary in `modules/telemetry`):

- `place.opened`
- `place.moved_trip`, `place.unassigned`
- `place.merged` (post-enrichment merge — actually performed)
- `place.duplicate_hint_skipped` (post-enrichment merge skipped because of conflicting `trip_id`s — feeds the future manual-merge UI; payload: winner_id, loser_id, both trip_ids)
- `place.enrichment_retried` (user-triggered retry from place detail)
- `source.opened`
- `source.assigned_trip`
- `source.no_places` (manual source completed extraction with 0 results)
- `feed.filter_changed` with `chip` (`all` | `untriaged` | `sources` | tag name)

No content (place names, OCR text, trip names) flows to telemetry — the existing privacy rule from ARCHITECTURE.md holds.

## Out of scope (deferred)

- **Multi-trip places.** A place lives in 0 or 1 trip. "Same place in two trips" is intentionally unmodeled today; if it comes up, revisit with a `place_trips` join table. Cheap to add later because trip is a single column.
- **Tags migration.** The existing `tags` table is keyed on `screenshot_id` (the column simply renames to `source_id` semantically; the `screenshots` rename leaves the FK valid). Re-keying tags onto `places` (so a place can be its own "place / food / activity" without going through a source) is a separate v0.2 follow-up. Until then the trip-detail tag filter chips are wired off the existing tag rows joined via `place_sources → sources → tags`. **Resolution rule for the transition:** a place is considered to carry tag `T` if _any_ of its sources carries tag `T`. Filter chips therefore behave as a logical OR across a place's sources; e.g., a place with one `food` source and one `place` source matches both filters. This is intentionally permissive during the transition; the place-keyed tags follow-up will let the user pick a single canonical tag per place.
- **Manual-merge UI.** When the post-enrichment merge is skipped because two places have conflicting `trip_id`s, the user gets no UI affordance in this change — only a `place.duplicate_hint_skipped` telemetry event. A future surface (e.g., "this might be the same place as X — merge?") will read those events into a real `place_duplicate_hints` table or query directly. Out of scope here.
- **Manual place creation** (without a source). Possible in the new model — `places` row with no `place_sources` — but no UI for it in this change.
- **Reordering / pinning places** in the trip view. Listed by `created_at` for now.
- **Bulk operations** on places (multi-select move/delete). Single-place operations only in this change.
- **Sync.** Forward-proofing rules already followed (UUIDs, soft-deletes, `owner_id`, `updated_at`).

## Non-goals (forever, restated)

- Multi-source-per-place is _not_ the start of social/sharing. Sources remain owned by one user.
- Canonical Place is _not_ a public catalogue. There is no shared backend "places database"; each user's `places` table is their own.
- The places-first restructure does _not_ expand the AI proxy. Same `/extract` and `/enrich` endpoints.
