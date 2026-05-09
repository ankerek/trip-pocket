# Trip Picker — Redesign

**Date:** 2026-05-09
**Component:** `components/TripPicker.tsx`
**Status:** Spec — ready for implementation plan

## Why

The current trip picker is a full-screen `pageSheet` modal with two sequential stages (list, then a separate "new trip" form). For a list of 1–5 trips it feels enormous, and the rows are bare slate-grey text with no visual hook. We want it more compact and more polished, without changing the public API or the three call sites that depend on it.

## Public API — unchanged

`TripPicker` keeps the same props and the same `onClose({ tripName }) | onClose(null)` contract. Callers in `app/triage.tsx`, `app/places/[id].tsx`, `app/sources/[id].tsx`, and `app/(tabs)/(places)/index.tsx` should not need to change.

```ts
type TripPickerProps = {
  visible: boolean;
  entityId: string | null;
  entityKind: 'source' | 'place';
  mode: 'assign' | 'move';
  onClose: (result: { tripName: string } | null) => void;
  assignOptions?: { excludePlaceIds?: string[] };
};
```

## Form factor — custom bottom sheet inside a transparent Modal

- Mount via `<Modal transparent animationType="none" visible={visible} onRequestClose={...}>`.
- Inside, render a full-screen container with:
  - A tap-to-dismiss backdrop: `rgba(15,23,42,0.42)`, fades in/out via Reanimated.
  - A bottom-anchored sheet: white, 22px top radius, drop shadow, safe-area bottom padding.
- Size the sheet to its content. With 1–5 trips no scrolling is needed; if the list grows past ~6 rows the sheet caps at ~70% of screen height and the row list becomes scrollable.
- Animate in: sheet slides up from bottom with a spring (Reanimated `withSpring`); backdrop fades in linearly. Reverse on dismiss.
- A 40 × 5 pt grabber is pinned at the top for visual affordance only — drag-to-dismiss is not implemented in v1 (backdrop tap and explicit cancel cover dismissal).
- Wrap the sheet content in `KeyboardAvoidingView` (`behavior="padding"` on iOS) so the inline create input rises with the keyboard.

**Why custom rather than native iOS detents:** the three call sites use the imperative `visible` + `onClose({ tripName })` pattern. Switching to an Expo Router `formSheet` with detents would mean passing IDs through search params and routing the result back through a global store at all three sites. The visual win is small; the plumbing churn is large.

**No new dependencies.** Reanimated is already in the project.

## Visual treatment — colorless and dense

- Centered title: "Add to trip" when `mode === 'assign'`, "Move to trip" when `mode === 'move'`. 15pt, weight 700.
- Each row: trip name on the left (15pt, weight 500), "N places" trailing meta on the right (13pt, slate-400, weight 500). Padding 15pt vertical / 20pt horizontal.
- Row separators: 0.5pt, `#f1f5f9`. No outer border on the sheet.
- "+ New trip" row pinned at the top: blue accent text (`text-blue-600`), weight 600, with a 22pt circular "+" badge in `bg-blue-100` / `text-blue-600`.
- No color dots, no color picker, no per-trip color anywhere in the picker. The `Trip.color` column stays in the schema but the picker neither reads nor writes it.
- Backdrop tap and grabber are the only dismiss affordances. No "Cancel" button in the header.

## Inline create — minimal

When the user taps "+ New trip", the create row swaps in place for an editable form row (the existing trip rows below stay where they are; the sheet auto-grows by the height delta). The form is a single line:

- Autofocused `TextInput` on the left (placeholder "Trip name", e.g. "Japan").
- A solid blue "Save" button on the right. Disabled until `name.trim().length > 0`.
- Submit (Save tap or keyboard return) creates the trip via `createTrip`, immediately assigns the entity via `assignSourceTrip` or `movePlaceToTrip`, and dismisses with `onClose({ tripName })`.
- Tapping the backdrop while editing collapses the form back to the static "+ New trip" row (does not dismiss the sheet). A second backdrop tap dismisses the sheet.

Empty state: when `listTrips()` returns `[]`, the picker opens directly into the editing form (no static "+ New trip" row to tap). This replaces the current "No trips yet — tap Create new trip" empty-state copy.

## Component breakdown — single file

All of the following live in `components/TripPicker.tsx`. Each is small enough to define inline; we are not splitting into separate files unless something exceeds ~80 lines.

- **`TripPicker`** — orchestrator. Owns `creatingNew: boolean`, `name: string`, `trips: TripWithCount[]`. Loads on `visible` flip. Renders `Backdrop`, `Sheet`, header, the list.
- **`Sheet`** — the animated bottom-anchored container. Wraps children in `KeyboardAvoidingView`.
- **`Backdrop`** — the dimmed tappable layer behind the sheet.
- **`TripRow`** — name + trailing "N places". Pressable with subtle highlight on press.
- **`CreateRow`** — static "+ New trip" row with the circular "+" badge.
- **`CreateForm`** — the inline TextInput + Save button row that replaces `CreateRow` when `creatingNew === true`.

## Storage — one new query

Add a place-count helper alongside the existing trip queries. Mirror the shape of `countSourcesByTrip` (already in `modules/storage/sources.ts`).

```ts
// modules/storage/places.ts
export async function countPlacesByTrip(db: Database): Promise<Record<string, number>> {
  const rows = await db.getAllAsync<{ trip_id: string; n: number }>(
    `SELECT trip_id, COUNT(*) AS n
       FROM places
      WHERE deleted_at IS NULL AND trip_id IS NOT NULL
   GROUP BY trip_id`,
  );
  const out: Record<string, number> = {};
  for (const r of rows) out[r.trip_id] = r.n;
  return out;
}
```

Re-export from `modules/storage/index.ts`.

In `TripPicker`, compose the result of `listTrips` with `countPlacesByTrip` into `Array<Trip & { placeCount: number }>`. Trigger via the existing `useLiveQuery` tick, but expand the watched tables to `['trips', 'places']` so counts stay accurate if a place is added or moved while the picker has been mounted.

## Behavior — preserved from current implementation

- **Storage call** — chosen by `entityKind`, not by `mode` (matching the current `assignTo()` implementation). `entityKind === 'source'` → `assignSourceTrip(db, entityId, tripId, assignOptions)`. `entityKind === 'place'` → `movePlaceToTrip(db, entityId, tripId)`.
- **`mode`** — controls only the sheet title ("Add to trip" vs "Move to trip"). Storage behavior is identical for both modes.
- **`assignOptions.excludePlaceIds`** — forwarded into `assignSourceTrip` exactly as today; the redesign does not touch this contract.
- **Haptics + toasts** — handled at call sites, unchanged. The picker stays UI-only.
- **Errors** — `Alert.alert('Could not assign trip', ...)` / `'Could not create trip'` on storage failures, same as today.

## Accessibility

- Sheet: `accessibilityViewIsModal={true}`.
- Backdrop: `accessibilityRole="button"`, `accessibilityLabel="Dismiss"`.
- Each `TripRow`: `accessibilityRole="button"`, `accessibilityLabel={trip.name}`, `accessibilityHint="Adds the place to this trip"` (or the move-mode equivalent).
- `CreateRow`: `accessibilityRole="button"`, `accessibilityLabel="Create new trip"`.
- `CreateForm` input: `accessibilityLabel="New trip name"`. Save button: `accessibilityRole="button"`, `accessibilityLabel="Save trip"`, `accessibilityState={{ disabled: !canSave }}`.

## Out of scope

- Color picker / per-trip color UI. Trip.color stays in the schema, untouched.
- Emoji picker / emoji column.
- Search field within the picker (1–5 trips, no need).
- Drag-to-dismiss on the grabber.
- Native iOS detent sheet via Expo Router. May revisit if a future use of the picker needs detent persistence.
- Any change to the three call sites' control flow.

## Files changed

- `components/TripPicker.tsx` — rewrite (single file).
- `modules/storage/places.ts` — add `countPlacesByTrip`.
- `modules/storage/index.ts` — re-export `countPlacesByTrip`.

## Test plan

- **Storage:** unit-test `countPlacesByTrip` against a seeded DB — mixed `trip_id`s, soft-deleted rows excluded, places with `null` trip_id excluded, missing trips returning `0`.
- **Component (RN testing-library):** picker opens with `listTrips` data merged into counts; tapping a row calls the right storage helper with the right args (assign-source, assign-place, move-place); tapping "+ New trip" reveals the form; submitting creates + assigns + dismisses; backdrop tap collapses the form first, then dismisses on second tap; empty trips list opens directly into the form.
- **Integration (manual):** triage flow assigns a source to a trip; place detail moves a place between trips; source detail assigns a source. All three should keep their existing haptic + toast behavior.
