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

**Cascade is symmetric.** A junction row is the only relationship between a place and a source. If deleting one entity (or the junction itself) leaves the other entity with zero live junctions, that other entity is also deleted — *unless* the surviving entity is a source that was deliberately preserved by `assignSourceTrip` (see §3.5).

## §1 — Schema changes

Migration `0002_drop_soft_delete.ts`:

1. **Cleanup pass** — for each table in dependency order (`place_sources` → `places` → `sources` → `trips`), `DELETE FROM <table> WHERE deleted_at IS NOT NULL`. This purges anything that was soft-deleted before the migration. Files referenced by any soft-deleted source row are also unlinked from disk; failures are logged and ignored (DB row is the source of truth, `cleanupOrphans` catches stragglers on next launch).
2. **Drop column** — `ALTER TABLE <table> DROP COLUMN deleted_at` for each of the four tables. SQLite ≥ 3.35 supports `DROP COLUMN`; Expo SQLite ships with a newer SQLite, so this is safe.
3. **Drop and recreate dependent indexes**:
   - `idx_sources_trip` (was `WHERE deleted_at IS NULL`) → recreate without the partial-index predicate.
   - `idx_sources_captured_at` → same.
   - `idx_sources_content_hash` → same.
   - `idx_places_normalized_owner` → same.
   - `idx_places_external` (was `WHERE external_place_id IS NOT NULL AND deleted_at IS NULL`) → recreate as `WHERE external_place_id IS NOT NULL`.
   - `idx_places_trip` → recreate without the predicate.
   - `idx_places_pending_enrichment` (was `WHERE enrichment_status = 'pending' AND deleted_at IS NULL`) → recreate as `WHERE enrichment_status = 'pending'`.
   - `idx_place_sources_source` → recreate without the predicate.
4. **Drop and recreate FTS5 triggers** — current triggers fire on `UPDATE OF ... deleted_at` and use the column to decide whether to insert or remove the FTS row. After migration the triggers fire on `AFTER INSERT` / `AFTER UPDATE OF <searchable cols>` / `AFTER DELETE`, with no `WHERE NEW.deleted_at IS NULL` guard. The DELETE triggers do the FTS row removal that was previously triggered by setting `deleted_at`.
5. **Schema version** bumped accordingly.

Existing migration tests in `modules/storage/__tests__/db.test.ts` get a new case that:
- Seeds a DB at the pre-migration schema with a mix of live and `deleted_at IS NOT NULL` rows.
- Runs the migration.
- Asserts: live rows preserved, soft-deleted rows gone, `deleted_at` column not present (queryable via `pragma_table_info`).

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
  filePath = SELECT file_path FROM sources WHERE id = ?
  DELETE FROM place_sources WHERE source_id = ?
  DELETE FROM sources WHERE id = ?
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

Symmetric with §3.1. A place with multiple sources survives a single-source delete; a place with one source disappears with it.

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
notifyChange('sources', 'places', 'place_sources', 'trips')
```

The "defensive untriage" UPDATE handles a niche edge case: a place with multiple sources, assigned to this trip, where one of its other sources lives in a different trip. We delete this trip's sources but the place itself has surviving evidence elsewhere — preserve the place, un-assign it from the deleted trip, do not yank it into a stranger trip.

`affectedPlaceIds` must be captured *before* the junction DELETE; otherwise the orphan-prune query has no way to know which places it's allowed to touch.

### §3.4 — Junction-only delete (existing `assignSourceTrip` excludePlaceIds path)

No behaviour change. The triage deselect-to-drop path stays as-is, with two purely mechanical edits:
- The junction `UPDATE ... SET deleted_at` becomes `DELETE FROM place_sources WHERE source_id = ? AND place_id = ?`.
- The orphan-place soft-delete becomes a hard-DELETE.

### §3.5 — Why `assignSourceTrip` does NOT trigger the source-prune rule

When triage's deselect-to-drop empties a place's last junction, the place is deleted (existing behaviour, kept). But the source whose junction we just deleted is *the entity being assigned* in the same transaction. The user has explicitly chosen to keep that source by picking a trip for it, even if no extracted places stick. This is the documented "save it anyway and label it later" path through triage — the placeholder copy in the triage card already says exactly that.

So: the source-prune rule fires inside `deletePlace` and `deleteSource`, not inside `assignSourceTrip`. Encoded as: `assignSourceTrip` deletes junctions and prunes orphan places only. It never inspects `place_sources` counts on the source side.

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

Pre-dialog count — number of sources that will be orphan-pruned, i.e. sources whose *only* live junction is to this place:

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
> This can't be undone.
> [Cancel] [Delete everything]

If `N === 0 && M === 0`, the cascade button is hidden — there is nothing to cascade and the gentle action does the same thing.

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

File deletion happens *outside* the SQLite transaction. We do not want disk failures to roll back the DB — the trash-can semantics are "user said gone, so it's gone from the DB; the bytes will catch up."

`cleanupOrphans` already exists (per the migration tests). Confirm it still does the right thing under the new contract — orphan = file on disk with no matching `sources.file_path` row. After this change there will be more orphan files because the cascade can fail mid-disk-cleanup; the orphan worker remains the safety net.

## §6 — Testing

### §6.1 — Storage unit tests

Existing `softDelete*` tests in `modules/storage/__tests__/{trips,sources,places}.test.ts` rewritten for the new `delete*` functions. Replace `expect(deleted_at).toBeTruthy()` style assertions with `expect(getX(...)).toBeNull()` and direct row-not-found checks.

New cases:
- `deletePlace` with a place that has 1 source whose only junction is this place → source row gone, file unlinked.
- `deletePlace` with a place that has 1 source which has 2 places → source survives, junction gone.
- `deletePlace` with a place that has 2 sources, each with only this place → both sources gone.
- `deleteSource` with a source whose place has only this source → place gone.
- `deleteSource` with a source whose place has 2 sources → place survives.
- `deleteTrip(mode='untriage')` → members untriaged, files untouched.
- `deleteTrip(mode='cascade')` end-to-end: trip + sources + files + places + junctions all removed; a place that had a second source in *another* trip survives, with `trip_id` cleared from this trip's slot.
- `assignSourceTrip(..., excludePlaceIds)` does NOT delete the assigned source even if all its junctions are excluded (regression test for §3.5).

### §6.2 — Migration test

`modules/storage/__tests__/db.test.ts` adds a case that:
- Opens the pre-migration schema (manually re-creates the old DDL inside the test, or pins the previous migration step).
- Inserts a known mix of live and `deleted_at IS NOT NULL` rows.
- Runs the migration to the target version.
- Asserts: live rows present, soft-deleted rows gone, `deleted_at` column not in `pragma_table_info(<table>)` for any of the four tables, FTS5 row count matches live places.

### §6.3 — FTS sanity

Add a test in the FTS coverage area (`modules/search/__tests__/`):
- Insert a place + linked source.
- Run `deleteSource` (which orphan-prunes the place).
- Query `places_fts MATCH 'name-of-the-place'` → 0 rows.

### §6.4 — UI smoke

Two render tests using React Native Testing Library:

1. **Triage CTA tray** — render `CtaTray` with `totalCount > 0`. Assert the "Delete" row exists with `accessibilityRole="button"` and `accessibilityLabel="Delete screenshot"`. `fireEvent.press` it and assert the supplied `onDelete` callback is called.
2. **Trip edit screen** — render with a stub trip that has 3 sources and 2 places. Assert both the "Delete trip" row and the "Delete trip and everything in it" row are present, distinguishable by accessibilityLabel. Press each and assert the corresponding storage call (`deleteTrip(id, 'untriage')` vs `deleteTrip(id, 'cascade')`) fires after confirm. Confirm-dialog interception is mocked at the `Alert.alert` boundary as the existing tests for `softDeleteSource` do.

## §7 — Roadmap impact

Empty-state audit and the perf pass shipped today (`86462c0`) leave v0.2 with two items still open: this delete-cascade work, and the deferred on-device perf measurement (which lives in v0.3). Once delete-cascade ships, v0.2 is feature-complete to the spec; the only outstanding item against the milestone is the v0.3-tagged measurement work.

ROADMAP.md will get a "delete cascade rewrite" line under v0.2 In flight pointing at this spec.

## §8 — Open questions

None. All forks were resolved during the brainstorm:
- Hard-delete + drop column: resolved.
- Trip delete: two affordances (gentle default, destructive opt-in): resolved.
- Source delete prunes orphan places, place delete prunes orphan sources: resolved (symmetric).
- Triage Delete affordance lives as the third tertiary row in the CTA tray: resolved.
- `assignSourceTrip` does NOT trigger the source-prune rule: resolved (§3.5).
