# Delete cascade — design

**Status:** approved (2026-05-10) · ready for implementation plan
**Touches:** `modules/storage/{trips,sources,places,place_sources}.ts`, `modules/storage/migrations/`, `app/triage.tsx`, `app/sources/[id].tsx`, `app/places/[id].tsx`, `app/trips/[id]/edit.tsx`, all FTS5 triggers, every `WHERE deleted_at IS NULL` filter in the codebase.

## Why

Two related problems with how delete works today:

1. **Soft-delete only, no purge.** Every `softDelete*` function flips `deleted_at` and returns. The row stays in SQLite, the screenshot file stays on disk, and there is no background job that ever cleans them up. iOS Settings > Storage will show the app size growing forever even though the user "deleted" things. The `deleted_at` column is plumbing for a feature (Recently Deleted / Undo) that does not exist in the UI.
2. **Cascade behaviour is asymmetric and partial.**
   - `softDeleteTrip` correctly untriages members (gentle).
   - `softDeleteSource` does not touch the junction or the places, so a place whose only evidence was this source survives as a phantom — name, photo, enrichment, but no screenshot the user can trace.
   - `softDeletePlace` mirrors that bug in the other direction: a screenshot whose only extraction was this place stays alive with zero live junctions.
   - Triage's deselect-to-drop already prunes orphan places, so the codebase already proves the user-facing cascade is "junction's last side disappearing takes the other side with it" — but only one of the four paths implements it.
3. **Triage has no Delete affordance.** Today the only ways out of a triage card are "Choose a trip", "Skip for now", or close-and-bail. There is no way to say "this screenshot is junk." Users have to leave triage, find the source in Pocket, open it, and use the menu — which is friction users do not pay for low-value screenshots.

## Scope

In scope:

- Replace soft-delete with hard-delete throughout. Drop the `deleted_at` column from `trips`, `sources`, `places`, `place_sources`. Remove every `WHERE deleted_at IS NULL` filter. Migrate FTS5 triggers from `UPDATE OF deleted_at` to `AFTER DELETE`.
- New cascade rules per §3.
- Two delete affordances on a trip: gentle (untriage members, default) and destructive (cascade everything, opt-in).
- New tertiary "Delete" action in the triage CTA tray.
- Confirm dialogs that surface orphan-prune impact in their copy.
- One-time cleanup migration that hard-deletes any pre-existing `deleted_at IS NOT NULL` rows before dropping the column.

Not in scope:

- Undo toasts, Recently Deleted shelves, restore-from-trash flows.
- Background purge scheduling (no soft-delete remaining ⇒ nothing to purge).
- Sync conflict resolution (v0.2 has no sync).
- Bulk-delete UI (multi-select in Pocket / Sources sub-tab).
- Trip cascade preview ("here's the 47 things that will go") — counts shown in confirm copy, not a list view.

## Contract

**Delete is final.** Tapping a delete affordance, confirming the dialog, and committing the SQLite transaction means: row is gone, screenshot file is gone, FTS5 entries are gone. There is no shelf, no toast, no undo. Confirm dialogs do the safety work.

**Soft-delete is removed from the schema.** SQLite hard-DELETE inside a transaction is immediately invisible to subsequent reads in the same transaction, so multi-step cascades do not need a soft-delete intermediate. The `deleted_at` column does not survive the migration.

**Cascade is symmetric.** A junction row is the only relationship between a place and a source. If deleting one entity (or the junction itself) leaves the other entity with zero live junctions, that other entity is also deleted — _unless_ the surviving entity is a source that was deliberately preserved by `assignSourceTrip` (see §3.5).

## §1 — Schema changes

**No migration.** Trip Pocket has no users; the existing `0001_init.ts` is the same kind of "collapse the history" rewrite the schema already underwent for the places-first restructure (see the file's own header comment). We edit `0001_init.ts` in place. Anyone with a pre-existing dev DB (i.e. simulator-installed app) wipes it: delete the app from the simulator, or remove `trip-pocket.db` from the app sandbox — same instruction the file already documents.

### §1.1 — Edits to `modules/storage/migrations/0001_init.ts`

1. **Drop the `deleted_at` column** from every table that declares it: `trips`, `sources`, `places`, `place_sources`, `tags`. Five table-creation statements lose one line each.
2. **Drop the partial-by-`deleted_at` predicates** from every index. The eight predicate-bearing indexes today become:

   ```sql
   CREATE INDEX        IF NOT EXISTS idx_sources_trip            ON sources(trip_id);
   CREATE INDEX        IF NOT EXISTS idx_sources_captured_at     ON sources(captured_at DESC);
   CREATE UNIQUE INDEX IF NOT EXISTS idx_sources_hash            ON sources(content_hash);
   CREATE INDEX        IF NOT EXISTS idx_places_normalized_key   ON places(normalized_key, owner_id);
   CREATE UNIQUE INDEX IF NOT EXISTS idx_places_external_place_id
          ON places(external_place_id, owner_id) WHERE external_place_id IS NOT NULL;
   CREATE INDEX        IF NOT EXISTS idx_places_trip             ON places(trip_id);
   CREATE INDEX        IF NOT EXISTS idx_places_enrichment_pending
          ON places(enrichment_status) WHERE enrichment_status = 'pending';
   CREATE INDEX        IF NOT EXISTS idx_place_sources_source    ON place_sources(source_id);
   ```

   The `idx_places_external_place_id` index keeps its `WHERE external_place_id IS NOT NULL` predicate (still needed — not all places are enriched). The partial-by-`deleted_at` half is gone, which forces the enrichment-merge resequence in §3.6.

3. **Rebuild the nine FTS triggers** without any `deleted_at` mentions. The bodies are otherwise unchanged. Concretely:
   - `places_fts_ai` — drop the `WHEN NEW.deleted_at IS NULL` clause; body unchanged.
   - `places_fts_au` — `AFTER UPDATE OF name, city, description ON places` (no `deleted_at`); drop the outer `WHERE NEW.deleted_at IS NULL`; drop both inner `WHERE deleted_at IS NULL` filters in the GROUP_CONCAT sub-queries.
   - `places_fts_ad` — unchanged.
   - `place_sources_fts_ai` — drop the `WHEN`; drop the inner `WHERE p.deleted_at IS NULL` and both sub-query `WHERE deleted_at IS NULL` filters.
   - `place_sources_fts_au` — `AFTER UPDATE OF raw_text, extracted_address ON place_sources` (no `deleted_at`); drop all three `deleted_at` filters in the body.
   - `place_sources_fts_ad` — drop the inner `WHERE p.deleted_at IS NULL` and both sub-query filters.
   - `sources_fts_ai` — drop the `WHEN`; relax the tag sub-query from `WHERE source_id = NEW.id AND deleted_at IS NULL` to `WHERE source_id = NEW.id`.
   - `sources_fts_au` — `AFTER UPDATE OF ocr_text, trip_id ON sources` (no `deleted_at`); drop the outer guard; drop the tag-subquery filter.
   - `sources_fts_ad` — unchanged.

4. **Header comment update** — refresh the file's leading comment to note that the soft-delete column is gone and that delete is hard, mirroring how the prior places-first restructure annotated itself in the same comment block.

### §1.2 — Developer ergonomics

Add a section to `docs/ARCHITECTURE.md` (or the README, whichever is closer to dev-onboarding instructions today) that says: "If you had the app running before this change, delete it from the simulator — the schema changed and the runner's version-skip means the new shape will not apply over your old DB." Same one-line note added to the `0001_init.ts` header comment so the next person who reads the schema sees the warning at the source.

## §2 — Application code: query cleanup

Every read in `modules/storage/*.ts` and every inline SQL in `app/**` and `components/**` currently has `WHERE ... deleted_at IS NULL`. After this change, those filters are removed because no live row has `deleted_at` anymore.

This is a mechanical pass but the surface is wide. The full list (from `grep -rn "deleted_at IS NULL"`):

- `modules/storage/places.ts` — 8 occurrences across listing / lookup / counting helpers.
- `modules/storage/sources.ts` — 9 occurrences.
- `modules/storage/trips.ts` — 4 occurrences.
- `modules/storage/place_sources.ts` — 6 occurrences.
- `app/(tabs)/(places)/index.tsx` — `PLACES_SQL`, `INBOX_COUNT_SQL`, `TRIPS_SQL`.
- `app/(tabs)/(search)/index.tsx` — `SEARCH_SQL`, `TRIPS_SQL`.
- `app/(tabs)/(trips)/index.tsx` — `COUNT_SQL`, `PREVIEWS_SQL`.
- `app/triage.tsx` — `EXTRACTED_SQL`.
- `app/trips/[id].tsx` — `TRIP_SOURCES_SQL`, `TRIP_PLACES_SQL`.
- `app/sources/[id].tsx` — inline place-count query.
- `app/sources/[id]/places-found.tsx` — `PLACES_SQL`, `STATUS_SQL`.
- `app/places/[id].tsx` — sources-strip query.

The migration drops the column, so a missed filter would surface as an `OperationalError: no such column: deleted_at` at first query. That is a loud, fast failure and exactly what we want. A `grep` audit at the end of implementation catches any stragglers before merge.

## §3 — Per-entity behaviour

All four functions live in their existing files (`places.ts`, `sources.ts`, `trips.ts`) and run inside a single `db.withTransactionAsync`. Names switch from `softDelete*` to `delete*`. Public API exported from `modules/storage/index.ts` updated.

### §3.1 — `deletePlace(db, placeId)`

```
TRANSACTION
  affectedSourceIds = SELECT source_id FROM place_sources WHERE place_id = ?
  DELETE FROM place_sources WHERE place_id = ?
  DELETE FROM places WHERE id = ?
  for each sourceId in affectedSourceIds:
    n = SELECT COUNT(*) FROM place_sources WHERE source_id = ?
    if n == 0:
      filePath = SELECT file_path FROM sources WHERE id = ?
      DELETE FROM sources WHERE id = ?
      pendingFileDeletes.push(filePath)
COMMIT
for each filePath in pendingFileDeletes:
  FileSystem.deleteAsync(filePath, { idempotent: true }).catch(log)
notifyChange('place_sources')
notifyChange('places')
notifyChange('sources')
notifyChange('trips')   // counts on trip detail / pocket may shift
```

The source-prune fires only when `affectedSourceIds.length > 0` and a source's count goes to 0. A source that the user kept deliberately with zero extracted places (the "couldn't read, save anyway" path through triage / skip) has no junctions and is therefore not in `affectedSourceIds` — it cannot be reached by this code path.

### §3.2 — `deleteSource(db, sourceId)`

```
TRANSACTION
  affectedPlaceIds = SELECT place_id FROM place_sources WHERE source_id = ?
  filePath         = SELECT file_path FROM sources WHERE id = ?
  DELETE FROM tags          WHERE source_id = ?    -- FK satisfaction
  DELETE FROM place_sources WHERE source_id = ?
  DELETE FROM sources       WHERE id = ?
  for each placeId in affectedPlaceIds:
    n = SELECT COUNT(*) FROM place_sources WHERE place_id = ?
    if n == 0:
      DELETE FROM places WHERE id = ?
COMMIT
FileSystem.deleteAsync(filePath, { idempotent: true }).catch(log)
notifyChange('sources')
notifyChange('place_sources')
notifyChange('places')
notifyChange('trips')
```

Symmetric with §3.1. A place with multiple sources survives a single-source delete; a place with one source disappears with it. The `tags` delete is FK-housekeeping — `tags.source_id REFERENCES sources(id)` is `NO ACTION`, so the source row delete would fail if any tag remained, even though v0.2 has no live tag writers.

### §3.3 — `deleteTrip(db, tripId, mode)`

`mode` is `'untriage'` (default) or `'cascade'`.

**Untriage mode:**

```
TRANSACTION
  UPDATE sources SET trip_id = NULL, updated_at = now WHERE trip_id = ?
  UPDATE places  SET trip_id = NULL, updated_at = now WHERE trip_id = ?
  DELETE FROM trips WHERE id = ?
COMMIT
notifyChange('sources')
notifyChange('places')
notifyChange('trips')
```

Members reappear in Pocket as Untriaged. No file or junction touched.

**Cascade mode:**

```
TRANSACTION
  // Snapshot what we will affect, BEFORE deleting anything.
  filePaths        = SELECT file_path FROM sources WHERE trip_id = ?
  affectedPlaceIds = SELECT DISTINCT place_id FROM place_sources
                      WHERE source_id IN (SELECT id FROM sources WHERE trip_id = ?)

  // FK-leaf cleanup first.
  DELETE FROM tags
   WHERE source_id IN (SELECT id FROM sources WHERE trip_id = ?)

  // Tear down junctions for this trip's sources.
  DELETE FROM place_sources
   WHERE source_id IN (SELECT id FROM sources WHERE trip_id = ?)

  // Orphan-prune places that just lost their last junction.
  // Scoped to affectedPlaceIds so we never touch places unrelated to this trip.
  DELETE FROM places
   WHERE id IN (affectedPlaceIds)
     AND id NOT IN (SELECT place_id FROM place_sources)

  // Defensive untriage: places that survived (still have other junctions) but were
  // explicitly assigned to this trip should not get deleted, but their trip_id must
  // be cleared so they don't dangle pointing at a deleted row.
  UPDATE places SET trip_id = NULL, updated_at = now WHERE trip_id = ?

  DELETE FROM sources WHERE trip_id = ?
  DELETE FROM trips   WHERE id = ?
COMMIT
for each filePath in filePaths:
  FileSystem.deleteAsync(filePath, { idempotent: true }).catch(log)
notifyChange('place_sources')
notifyChange('places')
notifyChange('sources')
notifyChange('trips')
```

The "defensive untriage" UPDATE handles a real edge case: a place with multiple sources, assigned to this trip, where one of its other sources lives in a different trip. We delete this trip's sources, but the place still has surviving evidence elsewhere — preserve the place, un-assign it from the deleted trip, do not yank it into a stranger trip. The user's confirm copy in §4.3 must reflect this: shared places do **not** get deleted by this cascade, only their trip_id gets cleared.

`affectedPlaceIds` must be captured _before_ the junction DELETE; otherwise the orphan-prune has no way to scope itself.

`notifyChange` is called once per channel post-commit; the live-query API (`live-query.ts:21`) takes a single table name per call and re-runs subscribed queries synchronously after each call, so call order across channels is irrelevant.

### §3.4 — Junction-only delete (existing `assignSourceTrip` excludePlaceIds path)

No behaviour change. The triage deselect-to-drop path stays as-is, with two purely mechanical edits:

- The junction `UPDATE ... SET deleted_at` becomes `DELETE FROM place_sources WHERE source_id = ? AND place_id = ?`.
- The orphan-place soft-delete becomes a hard-DELETE.

### §3.5 — Why `assignSourceTrip` does NOT trigger the source-prune rule

When triage's deselect-to-drop empties a place's last junction, the place is deleted (existing behaviour, kept). But the source whose junction we just deleted is _the entity being assigned_ in the same transaction. The user has explicitly chosen to keep that source by picking a trip for it, even if no extracted places stick. This is the documented "save it anyway and label it later" path through triage — the placeholder copy in the triage card already says exactly that.

So: the source-prune rule fires inside `deletePlace` and `deleteSource`, not inside `assignSourceTrip`. Encoded as: `assignSourceTrip` deletes junctions and prunes orphan places only. It never inspects `place_sources` counts on the source side.

The mechanical edits to `assignSourceTrip` (`sources.ts:191`) for this spec: the `excludePlaceIds` loop swaps `UPDATE place_sources SET deleted_at` → `DELETE FROM place_sources`, and the orphan-place soft-delete in the same loop swaps `UPDATE places SET deleted_at` → `DELETE FROM places`. The carve-out is preserved by what the function does **not** do — it has no source-prune branch and won't gain one.

### §3.6 — Enrichment merge: transferJunctions sequence rewrite

**Why this section exists.** The current enrichment-collision path (`modules/enrichment/enrichment.ts:246`) and `place_sources.transferJunctions` (`place_sources.ts:123`) lean on the partial unique index `idx_places_external_place_id … WHERE external_place_id IS NOT NULL AND deleted_at IS NULL`. The order is: soft-delete loser → move junctions → write enrichment columns to winner. Soft-deleting the loser drops it out of the partial index so the winner can take the same `external_place_id` without violating uniqueness.

After this spec, `deleted_at` is gone from places and the unique index narrows to `WHERE external_place_id IS NOT NULL`. The current sequence breaks: setting external_place_id on the winner while loser still has it would fail.

**New sequence.** Hard-delete the loser **before** any UPDATE that could collide on `external_place_id`. Junctions move first, loser is removed, then the winner gets enrichment columns:

```
TRANSACTION (inside enrichWithCollisionMerge)
  // 1. Move junctions from loser → winner. transferJunctions copies with
  //    ON CONFLICT(place_id, source_id) DO NOTHING, then DELETEs loser-side
  //    rows (no longer soft-deletes them).
  transferJunctions(db, loserId, winnerId)

  // 2. Hard-DELETE the loser place row. No FK violation: its junctions
  //    are gone, and v0.2's `places` table is referenced only by `place_sources`.
  DELETE FROM places WHERE id = ?  -- loserId

  // 3. If winner is the incoming place, promote its enrichment columns.
  //    Unique index passes because no other live row has external_place_id = X.
  if (winnerId === incomingPlaceId) writeEnrichmentColumns(winnerId, outcome)
COMMIT
notifyChange('place_sources')
notifyChange('places')
```

**`transferJunctions` rewrite.** `place_sources.ts:123` becomes:

```sql
INSERT INTO place_sources (
  place_id, source_id, extracted_at, raw_text, extracted_address,
  confidence, extraction_model, owner_id, created_at, updated_at
)
SELECT ?, source_id, extracted_at, raw_text, extracted_address,
       confidence, extraction_model, owner_id, created_at, updated_at
  FROM place_sources
 WHERE place_id = ?
   ON CONFLICT(place_id, source_id) DO NOTHING;

DELETE FROM place_sources WHERE place_id = ?;  -- was UPDATE … SET deleted_at
```

Same shape, hard-DELETE in the second statement instead of soft.

**Why this is not another `assignSourceTrip` carve-out.** `transferJunctions` re-homes each loser-side junction onto the winner before deleting it. The loser place therefore loses every junction in the same transaction, which is exactly the orphan-prune precondition for a place — and that's the desired outcome: the loser is being deleted on purpose. There is no "kept anyway" intent to protect, so the loser is never a candidate for the §3.5 carve-out. The fact that all junctions move to the winner means the **winner**'s junction count goes up, never down — so it cannot trigger the source-prune side of §3.1 either.

The corresponding test case (§6.1) covers this end-to-end: incoming + existing place collide on `external_place_id`, merge runs, both places' junctions end up on the winner, loser is gone, FTS rebuilt under the winner's id, no FK violations.

## §4 — UI surfaces

### §4.1 — Place detail (`app/places/[id].tsx`)

Existing menu has a Delete entry. Confirm copy unchanged in shape:

> Delete this place?
> This can't be undone.
> [Cancel] [Delete]

If `deletePlace` would orphan-prune sources (junction-count check before the dialog), the dialog body changes to:

> Delete this place?
> N screenshot(s) it came from will also be deleted.
> This can't be undone.
> [Cancel] [Delete]

Pre-dialog count — number of sources that will be orphan-pruned, i.e. sources whose _only_ live junction is to this place:

```sql
SELECT COUNT(*) AS n
  FROM place_sources ps1
 WHERE ps1.place_id = ?
   AND NOT EXISTS (
         SELECT 1 FROM place_sources ps2
          WHERE ps2.source_id = ps1.source_id
            AND ps2.place_id != ?
       )
```

Run when the dialog opens; if `n === 0` use the short copy variant, otherwise the long one.

### §4.2 — Source detail (`app/sources/[id].tsx`)

Same pattern as §4.1, in the other direction:

> Delete this screenshot?
> This can't be undone.

If `deleteSource` would orphan-prune places:

> Delete this screenshot?
> N place(s) extracted from it will also be deleted.
> This can't be undone.

Count: places whose only live junction is to this source.

### §4.3 — Trip edit (`app/trips/[id]/edit.tsx`)

Two delete actions in the existing edit screen, separated visually.

**Primary destructive ("Delete trip"):**

```
┌───────────────────────────────────────┐
│  Delete trip                       ›  │   slate-700 / red text
└───────────────────────────────────────┘
```

Confirm:

> Delete '{name}'?
> {N} screenshots and {M} places will move back to your Inbox.
> [Cancel] [Delete trip]

`N` and `M` come from `SELECT COUNT(*) FROM sources WHERE trip_id = ?` and the analogous places query, both run when the dialog opens.

**Secondary, more-destructive ("Delete trip and everything in it"):**

In a separate visual block — at minimum a hairline above and a different label color — so it cannot be tapped by mistake when the user means "delete trip":

```
┌───────────────────────────────────────┐
│  Delete trip and everything in it  ›  │   red, smaller weight
└───────────────────────────────────────┘
```

Confirm uses iOS `Alert` with destructive style and an explicit count:

> Delete '{name}' and {N} screenshots, {M} places?
> {S} place(s) shared with other trips will be moved to your Inbox.
> This can't be undone.
> [Cancel] [Delete everything]

`N`, `M`, and `S` are computed when the dialog opens. The shared-line is omitted when `S === 0`.

```sql
-- N: sources to be deleted.
SELECT COUNT(*) FROM sources WHERE trip_id = ?

-- M: places that will be deleted by the cascade. A place is deleted only if
-- every one of its junctions points at a source in this trip.
SELECT COUNT(*) FROM places p
 WHERE p.id IN (
   SELECT DISTINCT place_id FROM place_sources
    WHERE source_id IN (SELECT id FROM sources WHERE trip_id = ?)
 )
   AND NOT EXISTS (
     SELECT 1 FROM place_sources ps
      WHERE ps.place_id = p.id
        AND ps.source_id NOT IN (SELECT id FROM sources WHERE trip_id = ?)
   )

-- S: places that will SURVIVE (defensive untriage). They are in this trip
-- (either via trip_id or via at least one junction to this trip's sources)
-- but also have a junction to a source outside this trip.
SELECT COUNT(*) FROM places p
 WHERE (p.trip_id = ?
        OR p.id IN (SELECT DISTINCT place_id FROM place_sources
                     WHERE source_id IN (SELECT id FROM sources WHERE trip_id = ?)))
   AND EXISTS (
     SELECT 1 FROM place_sources ps
      WHERE ps.place_id = p.id
        AND ps.source_id NOT IN (SELECT id FROM sources WHERE trip_id = ?)
   )
```

If `N === 0 && M === 0 && S === 0`, the cascade button is hidden — there is nothing to cascade and the gentle action does the same thing.

### §4.4 — Triage CTA tray (`app/triage.tsx`)

The tray currently has two stacked buttons. Add a third row, visually quieter than "Skip", styled as a tertiary destructive text link:

```
┌──────────────────────────────────────────┐
│  📁  Choose a trip                  ⟩    │   primary teal
├──────────────────────────────────────────┤
│            Skip for now                  │   secondary slate-50 pill
├──────────────────────────────────────────┤
│              Delete                      │   tertiary, red text-link, no fill
└──────────────────────────────────────────┘
```

Spacing: 8pt gap between the three rows; the "Delete" row has the same horizontal alignment as "Skip" and is centred text only — no background, no border. Color `#dc2626` (red-600 in the existing palette family) on light, `#f87171` on dark. Hit target is 44pt minimum.

Tap → confirm dialog from §4.2 (uses the orphan-prune-aware copy variant when relevant). Confirmed → calls `deleteSource(db, current.id)`. After commit, the triage screen advances to the next source the same way `Skip` does (`advanceOrClose`). If that was the last item → `router.back()`.

Accessibility:

- `accessibilityRole="button"`
- `accessibilityLabel="Delete screenshot"`
- `accessibilityHint="Permanently delete this screenshot and any extracted places."`

## §5 — File cleanup

`modules/capture` exposes the storage directory and the file copy / move primitives. Reuse `expo-file-system`'s `deleteAsync(uri, { idempotent: true })`:

- `deletePlace`: no file work — places use a remote photo proxy URL with no local file. The proxy cache (HTTP layer) handles its own eviction.
- `deleteSource`: after the transaction commits, delete `source.file_path`. Failures are logged at `warn` and swallowed. The DB row is the source of truth; the existing `cleanupOrphans` worker (see `modules/capture/__tests__/cleanupOrphans.test.ts`) will sweep up any stragglers on the next launch.
- `deleteTrip` cascade: same as `deleteSource`, batched. Collect file paths inside the transaction (before `DELETE FROM sources`) and unlink them after commit.

File deletion happens _outside_ the SQLite transaction. We do not want disk failures to roll back the DB — the trash-can semantics are "user said gone, so it's gone from the DB; the bytes will catch up."

`cleanupOrphans` already exists (per the migration tests). Confirm it still does the right thing under the new contract — orphan = file on disk with no matching `sources.file_path` row. After this change there will be more orphan files because the cascade can fail mid-disk-cleanup; the orphan worker remains the safety net.

## §6 — Testing

### §6.1 — Storage unit tests

Existing `softDelete*` tests in `modules/storage/__tests__/{trips,sources,places}.test.ts` rewritten for the new `delete*` functions. Replace `expect(deleted_at).toBeTruthy()` assertions with `expect(getX(...)).toBeNull()` and direct row-not-found checks via `getAllAsync`.

Symmetric orphan-prune cases:

- `deletePlace` with a place that has 1 source whose only junction is this place → source row gone, file unlinked.
- `deletePlace` with a place that has 1 source which has 2 places → source survives, junction gone.
- `deletePlace` with a place that has 2 sources, each with only this place → both sources gone, both files unlinked.
- `deleteSource` with a source whose place has only this source → place gone.
- `deleteSource` with a source whose place has 2 sources → place survives.

Trip cases:

- `deleteTrip(mode='untriage')` → members untriaged, files untouched, tags untouched (when present).
- `deleteTrip(mode='cascade')` end-to-end: trip + sources + files + places + junctions + tags all removed.
- `deleteTrip(mode='cascade')` with a place shared across trips: the shared place survives with `trip_id = NULL`; the other trip's sources untouched; the cascade-deleted trip's sources/places/files all gone.

Carve-out / FK regression cases:

- `assignSourceTrip(..., excludePlaceIds)` does **not** delete the assigned source even if all its junctions are excluded (§3.5).
- `deleteSource` with a source that has tags → tags also deleted (FK regression).
- `deleteTrip(mode='cascade')` with sources that have tags → all tags deleted; assertion: `SELECT COUNT(*) FROM tags` is 0 in the affected scope.

Enrichment merge cases (§3.6):

- Incoming-wins merge: enrichment returns `external_place_id` X; existing place `E` already has X. Run `enrichWithCollisionMerge` for incoming `I`. Assert: `E` is gone, `I` survives with `external_place_id = X`, all junctions previously on `E` are now on `I` (deduped on conflict), `places_fts` row keyed by `I.id` reflects merged content.
- Existing-wins merge: `E.created_at < I.created_at` so `E` is winner. Assert: `I` is gone, `E` keeps its junctions plus any from `I` it didn't already have, `E.external_place_id` unchanged.
- Merge with junction conflict: both `E` and `I` already attach the same source `S`. Run merge. Assert: only one (winner-keyed) junction for `S` remains, no PRIMARY KEY violation, `place_sources` count for the winner equals `|junctions(E) ∪ junctions(I)|`.

### §6.2 — Schema-shape tests

There is no migration to test (§1). Existing tests in `modules/storage/__tests__/db.test.ts` already exercise `0001_init.ts`; they are extended with:

- `pragma_table_info` assertions: `deleted_at` is not a column of `trips`, `sources`, `places`, `place_sources`, or `tags`.
- `SELECT sql FROM sqlite_master WHERE type='index'` for each of the eight predicate-bearing indexes asserts the SQL no longer contains `deleted_at`.
- INSERT a place + junction + source after init. Assert: `places_fts` and `sources_fts` are populated by the rebuilt triggers (no `deleted_at` filter dropping the row).
- UPDATE `places.name` after init. Assert: the `places_fts_au` trigger fires and the FTS row reflects the new name (regression check that the trigger's `UPDATE OF` column list edit didn't accidentally drop `name`).

### §6.3 — FTS sanity

Cases in `modules/search/__tests__/`:

- **Place orphan-prune via deleteSource removes places_fts** — insert a place with one source linked, run `deleteSource`, assert `places_fts MATCH 'name'` returns zero rows.
- **Source orphan-prune via deletePlace removes sources_fts** — insert a source with one place linked (the place is the source's only junction), run `deletePlace`, assert `sources_fts MATCH 'ocr-text'` returns zero rows.
- **Junction-only delete rebuilds places_fts** — insert a place with two junctions to two sources whose `raw_text` differs. Run `assignSourceTrip(..., excludePlaceIds)` to drop one junction. Assert: place survives, `places_fts` row for that place no longer contains the dropped junction's `raw_text` token.
- **Cascade trip delete removes both FTS docs** — insert a trip with sources and places, run `deleteTrip(mode='cascade')`, assert both `places_fts` and `sources_fts` are empty for the deleted ids.

### §6.4 — UI smoke

Two render tests using React Native Testing Library:

1. **Triage CTA tray** — render `CtaTray` with `totalCount > 0`. Assert the "Delete" row exists with `accessibilityRole="button"` and `accessibilityLabel="Delete screenshot"`. `fireEvent.press` it and assert the supplied `onDelete` callback is called.
2. **Trip edit screen** — render with a stub trip that has 3 sources and 2 places. Assert both the "Delete trip" row and the "Delete trip and everything in it" row are present, distinguishable by accessibilityLabel. Press each and assert the corresponding storage call (`deleteTrip(id, 'untriage')` vs `deleteTrip(id, 'cascade')`) fires after confirm. Confirm-dialog interception is mocked at the `Alert.alert` boundary as the existing tests for `softDeleteSource` do.

## §7 — Roadmap impact

Empty-state audit and the perf pass shipped today (`86462c0`) leave v0.2 with two items still open: this delete-cascade work, and the deferred on-device perf measurement (which lives in v0.3). Once delete-cascade ships, v0.2 is feature-complete to the spec; the only outstanding item against the milestone is the v0.3-tagged measurement work.

ROADMAP.md will get a "delete cascade rewrite" line under v0.2 In flight pointing at this spec.

## §8 — Open questions

None. All forks were resolved during the brainstorm and the codex pre-implementation review:

- Hard-delete + drop column: resolved.
- Trip delete: two affordances (gentle default, destructive opt-in): resolved.
- Source delete prunes orphan places, place delete prunes orphan sources: resolved (symmetric).
- Triage Delete affordance lives as the third tertiary row in the CTA tray: resolved.
- `assignSourceTrip` does NOT trigger the source-prune rule: resolved (§3.5).
- Migration vs. in-place schema rewrite — no users, so we edit `0001_init.ts` and ask devs to wipe their dev DB (matches existing precedent in the file's own header): resolved (§1).
- Tags table — included in §3.2 / §3.3 cascades and the schema rewrite: resolved.
- Enrichment merge collision after `deleted_at` removal — resequence to junctions-move → loser-DELETE → winner-promote: resolved (§3.6).
- Cascade-mode confirm copy — counts the actual deletion outcome and discloses surviving shared places: resolved (§4.3).
