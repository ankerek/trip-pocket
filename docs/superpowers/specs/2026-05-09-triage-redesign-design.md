# Triage redesign — design

**Status:** approved (2026-05-09) · ready for implementation plan
**Replaces:** the post-2026-05-07 triage flow defined in `2026-05-07-v0.1-next-triage-trips-detail-design.md` §triage and the related sections of `2026-05-08-places-first-restructure-design.md`.

## Why

The current triage modal (`app/triage.tsx`) has three problems users hit:

1. The bottom sheet shows **only the first** extracted place per source. A screenshot of a 10-place food guide looks identical to a screenshot with one café — the user has no signal about what the source produced.
2. There is no way to selectively keep or drop extracted places. Today, picking a trip cascades every place linked to the source. A noisy extraction means the trip silently fills with junk.
3. The screen is `presentation: 'fullScreenModal'`. There is no swipe-down or back gesture — the only way to leave is the small X button. On iPhones, that's a reach problem and a discoverability problem.

InboxBanner visual refresh, quicker-trip-assignment shortcuts, and per-place inline editing are explicitly **out of scope**.

## Scope

In scope:
- Replace the triage card layout with a single vertical scroll (Layout "C").
- Show the full list of extracted places under each source.
- Per-place selection: default checked, user can deselect to drop a place.
- Restore swipe-down dismissal on iOS.
- Extend `assignSourceTrip` to honor selection.

Not in scope:
- `components/InboxBanner.tsx` — untouched.
- Quick-trip chips, recent-trip suggestions, swipe-to-assign.
- Per-place rename / category edit / city edit inside triage.
- Hero tap-to-expand into the full-screen image viewer.

## Layout (Option C)

A single vertical scrolling screen inside the existing horizontal pager. Top to bottom:

1. **Hero image** — `~240pt` tall, full width, `contentFit: 'cover'`, falls back to the dark sky placeholder used today when `filePath` is missing. Not full-bleed — the screen is now a content page, not a hero card.
2. **Top overlay** (absolute, over the hero) — same as today: X close button (left), `2 of 5` progress pill (center), 30pt spacer (right). Pill uses `tabular-nums`.
3. **Source meta block** (under hero, in flow):
   - Micro-label: `✦ N PLACES FOUND` (Mint `#0f766e`, uppercase, 0.6 letter-spacing). When `N === 0`, the label reads `COULDN'T READ` instead and is slate.
   - Title line: relative-time string from `captured_at`. Format rule: same string as `formatRelative` in `lib/relativeTime.ts` (or equivalent existing helper); render in the device locale and timezone, prefixed with `Captured `. Example output: `Captured today · 14:22`. If no helper exists today, add one in `lib/` rather than inlining `Intl.DateTimeFormat` calls in the screen.
4. **Section header** (only when `N > 0`):
   - Left: `Add to trip` (slate-500, uppercase, semibold, 11pt).
   - Right: `Deselect all` / `Select all` toggle (Mint, 11pt). Label rule: `Deselect all` when **every row is checked**, `Select all` otherwise (any row unchecked, including 0 of N).
5. **Place rows** — one row per live `place_sources` link of the source, ordered by `place_sources.extracted_at ASC` (matches `app/sources/[id]/places-found.tsx` so users see the same order across surfaces). Each row:
   - 44pt rounded thumbnail. If the place is enriched (`enrichment_status === 'enriched'` and `photo_name` set), render the enrichment photo via the existing photo URL builder used by `PlaceTile`/`PlaceRow`. Otherwise, render an emoji on a slate-100 background per category: `food` → 🍜, `activity` → 🏛, `place` → 📍, `null` → 📍 (same fallback as `place`).
   - Two-line text: `name` (15pt, semibold, slate-900) and `city · category` (12pt, slate-500). City and category use `· ` as separator; missing parts are skipped.
   - Trailing 26pt circular check. `on` = filled Mint with white check. `off` = transparent with 2pt slate-200 border.
   - Tapping anywhere on the row toggles the check.
   - Deselected rows render at 0.45 opacity, name strikes through with slate-300 strike color.
   - **Accessibility:** the row's outer `Pressable` uses `accessibilityRole: 'checkbox'`, `accessibilityState: { checked }`, `accessibilityLabel: name + (city ? ", " + city : "")`. The visual check icon is decorative (no separate label).
6. **Bottom CTA tray** — fixed at bottom of screen (not the bottom of scroll content), with a 96pt fade gradient above it so content scrolls under cleanly. The vertical scroll's `contentContainerStyle.paddingBottom` equals `trayHeight + safeAreaInsets.bottom + 16pt` so the last row never sits under the tray. Two buttons:
   - **Choose a trip** (mint, 14pt bold, full-width, rounded-2xl). Right-aligned counter inside: `Adding M of N ›` (10pt, 0.85 opacity). When `N === 0`, the counter is omitted (just `›`). When `M === 0` and `N > 0`, the counter still reads `Adding 0 of N ›` so the user sees what they're confirming.
   - **Skip for now** (slate-50 bg, slate-600 text, rounded-2xl). Always visible.

When the place list is empty (`N === 0`), the section header and rows are hidden. A short helper line under the source meta reads `Save it anyway and label it later.` (slate-500, 12pt). The CTA tray is unchanged.

## Navigation & gestures

- Horizontal swipe between sources (`FlatList` paging) — unchanged.
- `app/_layout.tsx` triage screen: switch `presentation: 'fullScreenModal'` → `presentation: 'modal'`. This gives the iOS sheet-card presentation with the standard swipe-down-to-dismiss gesture. The slight top inset is acceptable; the sheet is still full-bleed for the user-visible hero.
- `animation: 'slide_from_bottom'` is removed deliberately — `presentation: 'modal'` ships an iOS-native sheet animation and a platform-default Android animation, which is what we want. We do **not** need a custom animation for cross-platform parity here.
- The X button stays as an explicit dismiss for accessibility and Android parity.

**iOS safe-area & overlay anchoring.** The sheet card on iOS leaves a small top inset above the status bar. The hero `Image` fills the sheet's content frame from its top edge (no extra inset), and the **top overlay** (X button, progress pill) absolutely-positions at `safeAreaInsets.top + 8pt` so it lands just below the status-bar gap and over the hero. On Android, `safeAreaInsets.top` is 0 in modal presentation, so the overlay sits at `8pt` and renders correctly above the hero.

The two scroll axes are orthogonal: horizontal pager between sources, vertical scroll inside one source. The pager continues to disable scroll while `TripPicker` is open (existing rule, unchanged).

**TripPicker over the modal.** `TripPicker` opens as its own iOS sheet over the triage screen. While it's open, the triage screen's swipe-down gesture is suppressed by the OS (the topmost sheet owns the gesture). When the user dismisses the picker, focus returns to triage and the swipe-down gesture is re-enabled. No additional code is needed.

## Per-place selection — model

Component-local state, keyed by `sourceId` so deselections survive when the user pages between sources within a single triage session:

```ts
// outer key: sourceId. inner key: placeId. presence of an entry means
// the user has interacted with that source's row at least once.
type SelectionsBySource = Map<string, Map<string, boolean>>;
const [selections, setSelections] = useState<SelectionsBySource>(new Map());
```

Read rule for the current source `s`:
- If `selections.get(s.id)` exists, use it as the override map. Any place row not present in the override map is treated as **selected by default** (the default-on rule).
- If `selections.get(s.id)` is missing entirely, every row is selected by default.

This means the data structure stays compact — only deselected (or explicitly toggled) places need entries. New rows that arrive mid-triage (extraction landing while the user reads the card) inherit the default-on rule without any explicit write, matching "all places added by default".

Lifecycle:
- **Per-session**, not per-disk. The whole `selections` map lives in component state and is discarded when the modal unmounts (X tap, swipe-down, or after the last source is triaged).
- **Skipping** a source preserves its entry in `selections` (the user might swipe back). The source itself stays in the inbox.
- **Confirming a trip** for a source removes its entry from `selections` (it's no longer in the inbox queue, so any remaining state is moot).
- **Paging** between sources never rebuilds an existing entry. Only the first time the user toggles a row in a source does an entry get created.

Place row tap target = the entire row (rectangular, 60pt high). Toggling fires `Haptics.selectionAsync()` on iOS to match other selection affordances in the app.

The "Select all / Deselect all" header toggle for the current source:
- Label is `Deselect all` when **every** row is currently selected; `Select all` otherwise (any row unchecked, including the all-deselected state).
- Tap behavior is **set, not invert**: tapping `Deselect all` writes `false` for every place in the current source's list; tapping `Select all` writes `true` for every place. After the tap, the label flips to the opposite state.

## Confirm flow

When the user taps "Choose a trip", the existing `TripPicker` opens. The triage screen passes the current source's `excludePlaceIds` (placeIds where the selection map is `false`) into `TripPicker` via a new optional `assignOptions` prop. On confirmation, `TripPicker` continues to be the single place that calls `assignSourceTrip` — it now forwards `assignOptions` to that call:

```ts
// TripPicker.onConfirm (existing call site)
await assignSourceTrip(db, sourceId, tripId, assignOptions);
```

`assignOptions.excludePlaceIds` is the array of `placeId`s where the selection map is `false`. If the user kept everything selected, the array is empty (or the prop is omitted) and behavior is identical to today. All other `TripPicker` callers (e.g., `app/sources/[id].tsx` toolbar actions) omit the prop and behave identically to today.

### `assignSourceTrip` extension

The current signature in `modules/storage/sources.ts`:

```ts
export async function assignSourceTrip(
  db: Database,
  sourceId: string,
  tripId: string | null,
): Promise<void>
```

becomes:

```ts
export async function assignSourceTrip(
  db: Database,
  sourceId: string,
  tripId: string | null,
  opts?: { excludePlaceIds?: string[] },
): Promise<void>
```

Inside the existing transaction (`db.withTransactionAsync`), before the place-trip cascade runs, the function processes `excludePlaceIds`:

For each `placeId` in `excludePlaceIds`:

1. Soft-delete the `place_sources` row(s) for `(sourceId, placeId)`:
   ```sql
   UPDATE place_sources
      SET deleted_at = ?, updated_at = ?
    WHERE source_id = ? AND place_id = ? AND deleted_at IS NULL
   ```
2. Check whether the place has any remaining live `place_sources` rows:
   ```sql
   SELECT COUNT(*) AS n FROM place_sources
    WHERE place_id = ? AND deleted_at IS NULL
   ```
3. If `n === 0` **and** the `places` row has `trip_id IS NULL`, soft-delete the `places` row:
   ```sql
   UPDATE places
      SET deleted_at = ?, updated_at = ?
    WHERE id = ? AND trip_id IS NULL AND deleted_at IS NULL
   ```

**The rule in plain English:** keep the place row alive if it still has any reason to exist — either at least one live `place_sources` link, or an existing `trip_id`. Soft-delete the `places` row only when both anchors are gone. This is a strict "no dangling place rows for the user that they can still see anywhere else" guarantee, not just a multi-source guard.

Two consequences worth calling out:

- **Single-linked place already in a trip.** Suppose a place was previously triaged into trip T via source A. Source A's link is the only `place_sources` link. Source A is then deleted by the user (independent of triage). The place still has `trip_id = T` so it must remain visible in trip T. The deselect rule above never fires for this place during triage of some other source (no triage is happening for source A), but if a future flow ever did try to delete it, the `trip_id IS NULL` guard prevents accidental loss.
- **Multi-source place with no trip.** If place P is linked to sources A and B (both untriaged), deselecting P during triage of A leaves the link to B alive, so P survives until B is also triaged or deleted.

Then the existing place-cascade runs unchanged (it already filters both `places.deleted_at IS NULL` and `place_sources.deleted_at IS NULL`, so deselected places naturally do not move into the trip).

Finally:
- `notifyChange('sources')` — unchanged.
- `notifyChange('places')` — already gated on `movedPlaces`; extend the gate so it fires when any place is soft-deleted in step 3 too.
- `notifyChange('trips')` — unchanged.

All three steps run inside the same transaction so a failure rolls back as a unit.

### Existing callers

`app/sources/[id].tsx` ("Add to trip" / "Move to trip" toolbar actions) calls `assignSourceTrip` without the new option. Behavior is identical to today.

### `excludePlaceIds` contract for `tripId === null`

When `tripId === null` (the "Remove from trip" path), `excludePlaceIds` is **explicitly ignored**: the function does not run the deselect step, does not soft-delete any `place_sources` rows, and does not soft-delete any places. Rationale: "Remove from trip" is the inverse of triage, not a place-pruning operation. A future caller wanting to remove a source from a trip *and* drop specific places should be a separate API rather than overloading this one. Document this in the JSDoc on `assignSourceTrip` so the contract is impossible to miss.

## Skip

No mutation. Selection state, deselected toggles, all discarded. Source stays in inbox. Pager advances to the next source. Behavior identical to today.

## Edge cases

- **Mid-triage extraction completes.** `useLiveQuery` continues to drive `extractedBySource`. New rows arriving while the user is on a card are appended to the place list (in `extracted_at ASC` order, so they generally appear at the bottom) and default to checked under the per-source override-map rule.
- **Source with no extracted places.** Section header and rows hidden, helper copy shown. Selection map stays empty; `excludePlaceIds` is `[]`. Choose-a-trip works exactly as today (assigns the source, no places to cascade).
- **Place enrichment still pending.** Thumbnail falls back to category emoji. The selection toggle is unaffected; enrichment running in the background does not block triage.
- **Place already in a trip via another source.** Deselect breaks the current source's link only. The `trip_id`-guard in the rule keeps the place alive in its existing trip even if `n === 0` after the link is removed.
- **Single-linked place already in a trip.** Cannot occur during triage of that source's link (the source would already be in a trip and not in the inbox). Documented under "Two consequences worth calling out" above for completeness.
- **User deselects every place.** CTA shows `Adding 0 of N ›`. On confirm, all `N` places get processed by the deselect-rule (each is soft-deleted unless multi-linked or already in another trip), source goes to the trip, no places follow.
- **User pages back to a source they already deselected places on.** The `selections` map preserves the per-source override map across pager moves, so prior toggle state is intact when they return.
- **Race: user deselects a place that was just soft-deleted by orphan-cleanup.** Soft-delete is idempotent; the second `UPDATE` is a no-op. Acceptable.

## Files touched

| Path | Change |
|------|--------|
| `app/triage.tsx` | Rewrite `TriageCard` and `TriageSheet` to Layout C. Add per-source selection state and the place row component. Wire `excludePlaceIds` into the `TripPicker.onClose` callback. |
| `app/_layout.tsx` | Triage screen: `presentation: 'modal'` (was `'fullScreenModal'`); drop `animation: 'slide_from_bottom'`. |
| `modules/storage/sources.ts` | Extend `assignSourceTrip` with `opts.excludePlaceIds`. Add the in-transaction deselect logic per the rule above. Extend the `notifyChange('places')` gate so it fires when a place is soft-deleted. |
| `modules/storage/__tests__/sources.test.ts` | Add tests for the deselect cases and the delete-only `notifyChange('places')` gate (see Testing). |
| `components/TripPicker.tsx` | Add an optional `assignOptions?: { excludePlaceIds?: string[] }` prop. When set, the picker forwards it to its internal `assignSourceTrip` call. All existing callers omit the prop and behave identically. |
| `components/__tests__/TripPicker.test.tsx` | New (or extend if exists). Assert the picker forwards `assignOptions` to `assignSourceTrip` correctly, and behaves identically when the prop is omitted. |
| `__tests__/triage.test.tsx` | New. Cover default-on, single-row toggle, bulk-toggle (set semantics), selection persistence across paging, and the confirm-flow `excludePlaceIds` payload. |
| `lib/relativeTime.ts` (or equivalent) | Add a `formatCapturedAt(date)` helper if one doesn't already exist, returning strings like `Captured today · 14:22`. Locale + timezone come from the device. |

### Single source of truth for the assign call

`TripPicker` continues to own the `assignSourceTrip` call. The triage screen passes `excludePlaceIds` into the picker via a new optional `assignOptions` prop; the picker forwards it through. There is no path where the triage screen calls `assignSourceTrip` directly. This keeps mutation in one place and avoids two divergent call sites that could go out of sync.

(Considered alternative: move the assign call out of `TripPicker` so the component only returns a chosen trip and the caller mutates. Cleaner long-term but a bigger refactor; deferred to a follow-up if more callers grow custom assign behavior.)

## Testing

`modules/storage/__tests__/sources.test.ts`, new cases (assumes existing test fixtures for trips, sources, place_sources, places):

1. **Deselect a single-linked place** — given a source with one place, calling `assignSourceTrip(db, sId, tId, { excludePlaceIds: [pId] })`:
   - `place_sources(sId, pId).deleted_at` is set.
   - `places(pId).deleted_at` is set.
   - `places(pId).trip_id` remains `NULL`.
   - The source has `trip_id = tId`.

2. **Deselect a multi-linked place** — given a place linked from two live sources, calling the assign on source A with the place excluded:
   - `place_sources(sA, pId).deleted_at` is set.
   - `place_sources(sB, pId).deleted_at` is `NULL`.
   - `places(pId).deleted_at` is `NULL`.
   - `places(pId).trip_id` unchanged.

3. **Deselect a place already in another trip** — given a place with `trip_id = tOld` and one source link to source B (not the one being triaged):
   - `assignSourceTrip(db, sA, tNew, { excludePlaceIds: [pId] })` (sA also links to pId).
   - `place_sources(sA, pId).deleted_at` is set.
   - `places(pId).deleted_at` stays `NULL` (multi-linked).
   - `places(pId).trip_id` stays `tOld`.

4. **No exclusions** — calling `assignSourceTrip(db, sId, tId)` (no opts, or `excludePlaceIds: []`) behaves identically to the pre-change function. Existing tests cover this; verify they still pass.

5. **Empty trip target** — calling `assignSourceTrip(db, sId, null, { excludePlaceIds: [pId] })` ignores `excludePlaceIds` (no cascade runs, source goes back to inbox). The deselect step also no-ops because we only run it when `tripId !== null`. Add an explicit test asserting `place_sources(sId, pId).deleted_at` and `places(pId).deleted_at` are both `NULL` afterwards.

6. **Notify gating: delete-only path** — given a source with one place, all selected, then a second call to `assignSourceTrip(db, sId, tId, { excludePlaceIds: [pId] })`. Even though zero places are *moved* (the place was already in `tId` from the first call... but that contradicts the multi-link guard — better setup: give source two places, P1 selected, P2 deselected). Assert that subscribers registered on `'places'` invalidations fire because P2 was soft-deleted, even though P1 was the only place that moved. This guards the extended `notifyChange('places')` gate.

### `TripPicker` test (`components/__tests__/TripPicker.test.tsx`, new file if absent)

7. **Forwards `assignOptions`** — render `TripPicker` with `assignOptions={{ excludePlaceIds: ['p1'] }}`, mock `assignSourceTrip`, simulate a trip selection. Assert the mock is called with `(db, sourceId, tripId, { excludePlaceIds: ['p1'] })`. Render again without the prop and assert the mock is called with three arguments only (no opts).

### `app/triage.tsx` UI tests (`__tests__/triage.test.tsx`, new)

The component is presentation-heavy but the selection-state rules are too easy to regress to leave untested. Use React Native Testing Library with the existing test setup:

8. **Default-on rule** — render triage with one source and three places. Assert all three rows are rendered with `accessibilityState: { checked: true }`. CTA shows `Adding 3 of 3 ›`.

9. **Single-row toggle** — tap a row's outer `Pressable`. Assert that row's `checked` flips to `false`, the others stay `true`, and the CTA reads `Adding 2 of 3 ›`.

10. **Bulk toggle — set, not invert** — start at all-checked. Tap the header toggle (label `Deselect all`). Assert all rows are `checked: false` and the label flips to `Select all`. Tap once more — all rows go back to `checked: true`. Then deselect a single row, tap `Deselect all` again — all become `false` (not the inverse of the current state).

11. **Selection persists across paging** — render with two sources, deselect a place on source 1, page to source 2, page back to source 1. Assert the deselected place is still `checked: false`.

12. **Confirm passes `excludePlaceIds`** — deselect one place, tap Choose-a-trip, simulate the picker's `onClose` with a chosen trip. Assert `assignSourceTrip` was called with `excludePlaceIds: [<deselectedId>]`.

## Migration & data

No schema migration. The change is behavior on top of existing tables (`places.deleted_at`, `place_sources.deleted_at` already exist).

No data backfill. Existing inbox sources continue to work. The first time a user triages after this ships, the new card layout shows the existing extracted rows.

## Open questions / follow-ups (not blocking)

- Should the hero be tappable to open the full-screen image viewer (`/sources/[id]`)? Defer.
- Banner visual refresh — separate spec.
- Recent-trip chips above the "Choose a trip" CTA so common trips are one-tap — separate spec.
- Per-place rename inside triage (the user asked to avoid this in v1) — defer.
- Should "Skip" optionally remove the source from the queue (so the user doesn't re-triage it next time)? Today, skip leaves it for the next session. Defer.
