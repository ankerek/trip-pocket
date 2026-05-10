# Background Progress Feedback — Design

**Date:** 2026-05-10
**Status:** ready for review

## Goal

Tell the user that something is happening while the OCR → AI extraction → Google Places enrichment → AI summary pipeline runs in the background. Today, after a user adds a screenshot the UI is silent until extraction finishes and place tiles materialize, which reads as "nothing is happening". Place Detail has the same problem — opening a card before enrichment lands shows an empty hero with only a small "Looking up details…" line in the metadata block.

After this ships:

- The Pocket grid shows a `Processing N…` banner whenever any source has unfinished OCR or extraction.
- The Triage card shows a `PROCESSING…` label + skeleton rows for the current source while OCR/extraction are still running, instead of defaulting to the misleading `COULDN'T READ` copy.
- Place Detail shows skeletons over the hero, description, and metadata blocks plus a small `Looking up details…` status pill while enrichment is pending.
- The post-import `Alert.alert('Imported N…')` is dropped — the banner is now the confirmation.

## Non-goals

- **No global tab-bar / header indicator.** The three surface-local treatments are enough; a separate global signal was explicitly declined.
- **No per-stage labels.** Rolling everything up to one `Processing…` string is intentional — stage-by-stage copy was rejected as too chatty for the value it adds.
- **No new error UX.** Terminal failure copy on Place Detail (`Couldn't fetch details. Reopen to retry.` / `No match found in Maps.`) and the existing Triage `COULDN'T READ` fallback stay as-is. This spec only fixes the missing "in-progress" signal; error states are out of scope.
- **No pipeline event bus.** Reactivity continues to flow through the existing `notifyChange('sources' | 'places')` → `useLiveQuery` path. No new state machine.
- **No tappable banner.** The Pocket banner is informational in v1. No navigation, no dismiss.
- **No skeleton tiles in the Pocket grid.** The top banner is the only Pocket-level treatment; the grid keeps showing real places only.
- **No enrichment in the Pocket banner count.** The banner counts source-level work (OCR + extraction). Enrichment is on-demand (only fires when a card opens) and is surfaced per-Place-Detail, not aggregated.
- **No retry button on skeletons.** A source in `'failed'` status is not "in-flight" and not shown as a skeleton; today's silent-failure UX stays. Spec'ing retry UI is a separate piece of work.

## Context

The pipeline today, verified against code:

1. **Capture** — `modules/capture/ingest.ts` writes a `sources` row from either the share-extension inbox or `pickPhotosForImport`. New rows are `ocr_status='pending'`, `extraction_status='pending'`.
2. **OCR** — `modules/processing/processing.ts` (`runOcrSweep`) reads `sources` where `ocr_status='pending'`, runs Vision/ML-Kit OCR, writes `ocr_text` + `ocr_status='done' | 'failed'`, then chains into extraction.
3. **Extraction** — `modules/extraction/extraction.ts` (`runExtractionSweep`) reads where `extraction_status='pending' AND ocr_status='done'`, calls the `/extract` proxy, INSERTs `places` rows (each `enrichment_status='pending'`), and sets `extraction_status='done' | 'failed'`.
4. **Enrichment** — `modules/enrichment/enrichment.ts` (`enqueueEnrichment`) is called from Place Detail's mount effect when `enrichmentStatus ∈ {'pending', 'failed'}`. Calls the `/enrich` proxy → photo, lat/lng, rating, formatted_address, AI summary (`description`). Updates `enrichment_status='enriched' | 'not-found' | 'failed'`.

Every status transition already calls `notifyChange('sources')` or `notifyChange('places')`, which is what `useLiveQuery` subscribers in the UI listen on. The feedback we want is a function of these existing columns; no new state is required.

The user-visible gap right now:

- **Pocket grid** (`app/(tabs)/(places)/index.tsx`) only queries `places`. Sources mid-pipeline are invisible. After `pickPhotosForImport` the user sees an `Alert` ("Imported 3 · skipped 1"), dismisses it, and then waits in silence while OCR + extraction churn. Same for share-extension imports — the `InboxBanner` only shows on the Untriaged filter and only counts source rows, with no indication that pipeline work is in flight.
- **Triage card** (`app/triage.tsx`) live-queries `place_sources` joined with `places`. While OCR/extraction are still running on the current source, that query returns zero rows, so the bottom sheet renders the `total === 0` branch — `COULDN'T READ` + `Save it anyway and label it later.` — which reads as a terminal failure rather than "still working".
- **Place Detail** (`app/places/[id].tsx`) renders the `mappin` placeholder for the hero, no description block, and a small `Looking up details…` row inside the metadata card. The hero is the loudest element on the page and it's showing a not-found-looking glyph for the whole time enrichment runs.

## Architecture

Approach **A** (per-surface live queries, shared visual primitives) was chosen over a central status hook (B) or a pipeline event bus (C). Rationale:

- The existing `notifyChange` → `useLiveQuery` path already gives us frame-level reactivity on the columns we care about.
- Each surface only needs one slice of the predicate, so the central-hook abstraction would mostly be a wrapper.
- A new event bus would duplicate state (DB + events) and create replay-on-mount complexity for a problem the live-query layer solves.

### Shared predicates

One file, `modules/storage/processing-status.ts`, exporting:

```ts
export function isSourceProcessing(s: {
  ocr_status: 'pending' | 'done' | 'failed';
  extraction_status: 'pending' | 'done' | 'failed';
}): boolean {
  return s.ocr_status === 'pending' || s.extraction_status === 'pending';
}

export function isPlaceProcessing(p: {
  enrichment_status: 'pending' | 'enriched' | 'not-found' | 'failed';
}): boolean {
  return p.enrichment_status === 'pending';
}

// SQL fragment used by the Pocket banner count query.
export const PROCESSING_SOURCES_WHERE =
  `ocr_status = 'pending' OR extraction_status = 'pending'`;
```

Three reasons to centralize:

- All three surfaces use the same definition of "in-flight"; the helper guards against drift.
- `'failed'` is deliberately excluded from "in-flight" (it's a settled error). Putting that in one place keeps the spec's "no new error UX" boundary enforceable.
- The SQL fragment is reused verbatim by the Pocket count query and any future variants (e.g. per-trip).

### Reactivity wiring

Already in place. No new `notifyChange` calls are needed because every status transition in `processing.ts`, `extraction.ts`, and `enrichment.ts` already fires `notifyChange('sources')` or `notifyChange('places')`. Verified call sites:

- `processing.ts` — fires on OCR done and OCR failed.
- `extraction.ts` — fires on extraction done (also `places` + `place_sources`), permanent fail, and retry-exhausted fail.
- `enrichment.ts` — fires on `enriched`, `not-found`, and `failed`.

## Shared components

Three new pieces under `components/`:

### `<ProcessingBanner count={n} />`

- Pocket-only consumer in v1. File: `components/ProcessingBanner.tsx`.
- Renders `null` when `count === 0` so the parent can drop it directly into `ListHeaderComponent` without conditional layout work.
- Copy: `Processing {count} screenshot{count === 1 ? '' : 's'}…`. Leading `ActivityIndicator` (small, themed via `useThemeColors().accent`).
- Visual style mirrors `InboxBanner`: `mx-3.5 mt-1 mb-2`, `rounded-2xl`, `bg-info-bg`, `text-info-text`. Accessibility: `accessibilityRole="text"`, `accessibilityLabel` matches the visible copy. Not interactive (no `onPress`, no `accessibilityRole="button"`).

### `<SkeletonBlock />` / `<SkeletonRow />` / `<SkeletonLines />`

- File: `components/Skeleton.tsx` exporting all three.
- `SkeletonBlock` — fills its parent (default `width: '100%'`, `height: '100%'`). Used as the hero placeholder in Place Detail.
- `SkeletonRow` — the geometry of a `PlaceSelectRow` (44×44 leading square, two stacked text bars), used by Triage card.
- `SkeletonLines count={n}` — `n` stacked text-line bars at descending widths (100%, 92%, 60% for `count=3`), used by Place Detail's description.
- Animation: a single shared `Animated.Value` driving opacity between `0.4` and `0.8` over 1.2s, ping-pong via `Animated.loop`. One driver per component instance; cheap on the JS thread.
- Color: `bg-surface` (or `colors.surface` direct), no border. The animation is the affordance.

### `<StatusPill label="Looking up details…" />`

- File: `components/StatusPill.tsx`.
- A small inline chip: ActivityIndicator + label, rounded-full, `bg-info-bg`, `text-info-text`.
- Place Detail is the only consumer in v1 but the component is generic.

## Per-surface implementation

### Pocket grid — `app/(tabs)/(places)/index.tsx`

Add one live query and one component:

```ts
const PROCESSING_COUNT_SQL =
  `SELECT COUNT(*) AS n FROM sources WHERE ${PROCESSING_SOURCES_WHERE}`;

const processingRows = useLiveQuery<{ n: number }>(
  PROCESSING_COUNT_SQL,
  [],
  ['sources'],
);
const processingCount = processingRows?.[0]?.n ?? 0;
```

Render the banner inside `ListHeaderComponent`, **above** the `<FilterPills>` row, on every filter (it represents global processing state, not per-filter state):

```tsx
ListHeaderComponent={
  <View>
    <ProcessingBanner count={processingCount} />
    <FilterPills ... />
    {filter === UNTRIAGED_FILTER_ID ? <InboxBanner ... /> : null}
  </View>
}
```

Coexistence with `InboxBanner` is intentional: they communicate orthogonal things. `ProcessingBanner` says "the pipeline hasn't settled". `InboxBanner` says "you have unsorted screenshots". A user can be in both states (just imported 3 screenshots — pipeline still running and they're untriaged) or just one (pipeline done, but 3 still untriaged).

Also in this file, the empty-state branch:

```tsx
if (filteredPlaces.length === 0 && inboxCount === 0 && filter === ALL_FILTER_ID) {
  return <EmptyState ... />;
}
```

…must be extended so we don't render the empty state while sources are still being processed. Add `&& processingCount === 0` to the condition; otherwise the user who just imported their first screenshot sees the "No places yet" empty state for a few seconds before tiles materialize. While the pipeline runs, render the regular grid (which will be empty) with only the banner — same visual as the empty state but with the in-progress signal.

### `pickPhotosForImport` — `components/pickPhotos.ts`

Drop the trailing `Alert.alert(parts.join(' · ') || 'Nothing to import')`. Keep:

- The success/warning/error haptic — that's tactile confirmation that the import landed.
- The console warning on failed imports — useful for debugging.

If `outcome.imported === 0 && outcome.skipped === 0 && outcome.failed === 0` (the "Nothing to import" case — only reachable on truly weird input since `result.canceled` is already handled), do nothing further. The grid will be unchanged, the banner won't appear, and the user's "nothing happened" interpretation is correct.

### Triage card — `app/triage.tsx`

The screen doesn't currently observe the displayed source's `ocr_status` / `extraction_status`. Add a small live query keyed by `current.id` and subscribed to `['sources']`. One query per card is fine — Triage shows one card at a time and `current.id` only changes on swipe.

```ts
const STATUS_SQL = `SELECT ocr_status, extraction_status FROM sources WHERE id = ?`;
const statusRows = useLiveQuery<{ ocr_status: ...; extraction_status: ... }>(
  STATUS_SQL,
  current ? [current.id] : [],
  ['sources'],
);
const processing = statusRows?.[0]
  ? isSourceProcessing(statusRows[0])
  : false;
```

Render branches in the bottom sheet header:

| State                                              | Label              | Subhead                            | Body                              |
| -------------------------------------------------- | ------------------ | ---------------------------------- | --------------------------------- |
| `processing === true`                              | `PROCESSING…`      | (relative time, unchanged)         | 2× `<SkeletonRow />`              |
| `!processing && total === 0`                       | `COULDN'T READ`    | `Save it anyway and label it later.` | (no rows — unchanged from today)  |
| `!processing && total > 0`                         | `✦ N PLACES FOUND` | (unchanged)                        | real `<PlaceSelectRow />`s        |

Label styling: `PROCESSING…` uses the same `text-info-text` / `letterSpacing` / `fontWeight` as the existing `✦ N PLACES FOUND` label so it reads as a positive in-progress state, not a degraded fallback.

The `Select all / Deselect all` pill stays gated on `totalCount > 0`, so it's correctly hidden during processing.

### Place Detail — `app/places/[id].tsx`

The screen already enqueues enrichment in a `useEffect` when `enrichmentStatus ∈ {'pending', 'failed'}`. Keep that. New render branches keyed on `state.place.enrichmentStatus === 'pending'`:

- **Hero** — replace the `mappin` placeholder block (the `else` branch of `photoUrl ?` …) with `<SkeletonBlock />` covering the same 4:5 area. The gradient overlay, `OverlayCategoryChip`, name, and `HeroMetaRow` keep rendering on top — they're populated from extraction-time columns and are known immediately.
- **Description** — today the block is omitted when `place.description` is `null`. While pending, render `<SkeletonLines count={3} />` in a `px-4 pb-4 pt-4` wrapper instead of omitting.
- **Metadata block** — today renders `formattedAddress` only when truthy, plus the `enrichmentLabel(...)` info row. While pending, render two `SkeletonRow`-style rows inside the same `bg-surface` card (one for the address, one for the info line) so the card has shape.
- **Status pill** — add `<StatusPill label="Looking up details…" />` between the hero and the side-by-side primary action buttons (`Maps` / `Add to trip`), `mx-4 mt-4` so it sits above the actions. Visible only while pending.

The action buttons (`Open in Maps`, `Add to trip`), the sources strip, and the destructive footer stay rendered through the pending state — they all work without enrichment. Open-in-Maps falls back to name + city when lat/lng aren't yet populated (already true via `toMapTarget` and `openInMaps`'s existing fallback).

Once `enrichmentStatus !== 'pending'`:

- Hero swaps to the real photo (or the `mappin` fallback for `not-found`).
- Description block renders if `place.description` is non-null, else collapses.
- Metadata block renders `formattedAddress` if present + the existing `enrichmentLabel(status)` row (which already has the right copy for `enriched | not-found | failed`).
- Status pill unmounts.

## Edge cases

- **Sub-second pipeline**. If OCR + extraction finish before the user can perceive the banner (small screenshots, warm Vision cache), the banner appears for one frame and then unmounts. Acceptable — the live-query path is debounced at the SQL level only, not at the React level. We do **not** add a minimum display duration; it's deceptive.
- **App foregrounded mid-pipeline**. `runForegroundIngest` runs on app foreground and on pull-to-refresh. Sources that were `'pending'` when the app was backgrounded are picked up by the sweep; the banner will reflect their count from the moment the count query subscribes. No special replay logic needed.
- **Source stuck at `'failed'`**. Not counted as in-flight, so it does not contribute to the banner and does not show as a skeleton in Triage. Today's silent behavior is preserved (this is a known gap that error-UX work — out of scope here — will fix).
- **Enrichment retry on detail reopen**. The existing `useEffect` re-enqueues on `'failed'`. When the user reopens a failed-enrichment card, the status doesn't flip back to `'pending'` until the enricher actually starts the call (the enricher writes terminal statuses, not `'pending'`). For this slice we accept that the skeleton+pill won't be visible during the retry — the existing terminal copy still applies. If this becomes a real UX problem, the fix is a `pending`-on-retry write inside `enrichment.ts`; out of scope here.
- **Multiple sources for one place**. A place can be attached to multiple sources via `place_sources`. The Pocket banner counts sources, not places, so re-extracting a duplicate screenshot adds to the count cleanly. No place-level double-count.
- **Empty Pocket while pipeline runs**. Handled by adding `&& processingCount === 0` to the `EmptyState` gate. The user sees the banner over an empty grid, not the "No places yet" CTA.
- **`useLiveQuery` returns `null` on first render**. All three subscriptions can be `null` briefly. `processingCount` short-circuits to `0` (no banner — correct), `processing` short-circuits to `false` (Triage renders the `total === 0` branch for one frame, then re-renders — acceptable; this only happens during initial mount when there's nothing to triage anyway), Place Detail's gating is on `state.kind === 'loaded'` so the skeletons render only after the initial place fetch resolves.
- **Banner during Triage**. The Pocket banner lives on the Pocket grid only. Opening Triage is a separate screen (`app/triage.tsx`); the banner isn't shown there. That's correct — Triage has its own per-card processing indicator.

## Testing

The existing test infra is `jest-expo` with the in-memory `expo-sqlite` mock and `@testing-library/react-native` (used today only at the `renderHook` level — no full screen-rendering tests yet). The spec sticks to what that infra already supports.

Unit tests:

- `modules/storage/__tests__/processing-status.test.ts` — exhaustive cases for `isSourceProcessing` (covers `pending/pending`, `done/pending`, `pending/done`, `done/done`, `failed/done`, `done/failed`, `failed/pending`) and `isPlaceProcessing` (one case per `enrichment_status` value).

Live-query integration tests (in the style of `modules/storage/__tests__/live-query.test.ts`, using `renderHook`):

- `modules/storage/__tests__/processing-status.live.test.ts` — assert that `useLiveQuery` over `PROCESSING_COUNT_SQL` (a) returns `0` on an empty DB, (b) returns `2` after inserting two `ocr_status='pending'` sources, (c) returns `0` after both transition to `ocr_status='done', extraction_status='done'`, (d) ignores sources with `ocr_status='failed'`.

Component test for the banner (pure props → markup, no DB needed):

- `components/__tests__/ProcessingBanner.test.tsx` — renders `null` at `count={0}`; renders `Processing 1 screenshot…` at `count=1`; renders `Processing 3 screenshots…` at `count=3`.

Screen-level RTL tests for Triage and Place Detail are **deferred**: rendering an `expo-router` screen end-to-end isn't established in this repo's test setup and the cost of standing it up is larger than this feature warrants. Behavioral coverage comes from the live-query test + manual QA. If the screen-rendering test harness lands later, the cases worth adding are listed in "Future work" below.

## Out of scope / future work

- Retry UI for `'failed'` sources and `'failed'` places.
- Per-stage progress (`Reading text…` → `Extracting places…` → `Looking up details…` → `Writing summary…`).
- Tap-to-expand on the Pocket banner showing a list of in-flight screenshots.
- Global tab-bar dot or header chip.
- Surfacing enrichment status outside Place Detail (e.g. a "loading" treatment on Pocket tiles while their enrichment is pending).
- Screen-level RTL tests (Triage `PROCESSING…` ↔ `COULDN'T READ` ↔ `N PLACES FOUND` branching; Place Detail pending ↔ enriched branching; Pocket banner mount/unmount on live `sources` changes). Worth adding once `expo-router` screens have a render harness in this repo.
