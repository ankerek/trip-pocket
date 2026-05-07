# OCR Pipeline + Search — Design

**Date:** 2026-05-07
**Status:** ready for review
**Roadmap:** v0.2, item 1 of the sequenced pipeline (OCR → AI extraction → classifier-gated auto-detect). Ships on-device OCR for every captured screenshot plus a search screen powered by SQLite FTS5. Auto-detect and AI extraction are out of scope for this spec.

## Goal

Make every screenshot's text searchable. After this ships, the user can tap a magnifier in Inbox or any trip detail, type a fragment of any text seen in any screenshot they've captured, and find that screenshot in the result list with the matching text highlighted.

The pipeline is invisible by default: screenshots appear in Inbox the instant they're imported. Text becomes searchable seconds later, in the background, with a subtle shimmer on the thumbnail while OCR is pending.

## Non-goals

- AI place extraction. That's a separate v0.2 spec; OCR text is the input it consumes, but the proxy and `extracted_places` table are not touched here.
- Auto-detect of new screenshots. Sequenced after AI extraction; explicitly deferred.
- Indexing tags or extracted place names in the FTS document. Those features don't exist yet; when they ship, the FTS document and triggers expand to include them.
- Indexing trip names in FTS. Trip names are a small set (5–20 typical); a `JOIN trips` in the search query is simpler and good enough for v0.2. Revisit if trip count ever grows past where a join becomes a problem.
- Background OCR via `BGTaskScheduler`. ARCHITECTURE.md explicitly defers this; the foreground sweep + import-time kickoff is the v0.2 model.
- iOS-side text-region detection or bounding-box-aware UI. We extract concatenated text only.
- Search history, saved searches, or recent-query suggestions.
- Cross-language transliteration ("tonkatsu" matching "とんかつ"). The Vision OCR text is what it is; FTS5 with `unicode61` tokenizer handles diacritics and case-folding only.
- Persisting OCR retry state to disk. The retry counter lives in memory and resets on app launch — by design, so a freshly relaunched app gets one more honest try at every `failed` row before shrugging.

## Context

The DB schema already has all the columns we need:

- `screenshots.ocr_status` — `pending | done | failed`, default `pending`.
- `screenshots.ocr_text` — nullable text.
- `screenshots_fts` — FTS5 virtual table with `screenshot_id UNINDEXED`, `content`, `tokenize = 'porter unicode61'`. Currently empty (nothing writes to it yet).

What's missing:

- A native module that actually runs Apple Vision text recognition.
- A processing module that owns the OCR lifecycle: pending → done | failed, with retry.
- SQLite triggers that keep `screenshots_fts.content` in sync with `screenshots.ocr_text`.
- A search screen and the magnifier-icon entry points.
- Pending-shimmer treatment on thumbnails.

A few smaller fix-ups land alongside:

- `modules/capture/importImage.ts` accepts `source: 'share' | 'manual'` but the schema check constraint is `'share' | 'manual' | 'auto'`. The TS type widens to match. No runtime change in v0.2 (only auto-detect uses `'auto'`); this just removes a type-level lie before auto-detect lands.

## Architecture

```
[importImage success]                  [App foreground]
        │                                     │
        │ enqueueOcr(id)                      │ runOcrSweep(db)
        ▼                                     ▼
                 modules/processing
              ┌──────────────────────┐
              │  serial Promise queue │
              │  (single in-flight)   │
              └──────────┬────────────┘
                         │
                         ▼
                native VisionOCR
              ┌──────────────────────┐
              │  VNRecognizeTextRequest│
              │  on serial DispatchQueue│
              │  auto-detect language │
              └──────────┬────────────┘
                         │
            success ─────┴───── failure
                │                  │
                ▼                  ▼
   UPDATE screenshots          retry ≤3 in-memory
     SET ocr_text=?,             │
         ocr_status='done'       └──▶ ocr_status='failed'
                │                          │
                │ trigger fires            │ next foreground sweep re-pulls
                ▼                          │ (counter resets per app launch)
       screenshots_fts updated             ▼
                                       back to pending
```

```
[Inbox / Trip detail header]
        │ tap magnifier
        ▼
   app/search.tsx                 ── new screen
   ├─ TextInput (autofocus)
   ├─ Trip filter chip row (optional)
   └─ FlatList of results
        │  query: SELECT … FROM screenshots_fts JOIN screenshots …
        │         WHERE screenshots_fts MATCH ?  ORDER BY rank LIMIT 50
        │  each row renders: thumbnail + highlighted snippet + trip badge
        │
        │ tap result
        ▼
   existing screenshot detail screen
```

## Components

### `native/VisionOCR/` — new Expo Module (Swift)

Single async export:

```ts
recognizeText(imagePath: string): Promise<string>
```

Returns concatenated text in top-to-bottom reading order. Throws on Vision-side errors (image decode failure, file unreadable, request cancellation).

Implementation notes:

- `VNRecognizeTextRequest`. `recognitionLevel = .accurate`. `automaticallyDetectsLanguage = true` (per design Q2 — picks language per request, no maintenance cost). `usesLanguageCorrection = true`.
- Loads the image as a `CGImage` via `CGImageSourceCreateWithURL`. Streams from disk; never holds a `UIImage`.
- All Vision work runs on a private serial `DispatchQueue` (`com.trippocket.VisionOCR.queue`). This is a defense-in-depth serializer beyond the JS-side queue: even if a future caller skips `modules/processing`, two requests can't run concurrently inside the module.
- Joins `VNRecognizedTextObservation` results with `\n` between observations. We don't need bounding boxes yet.
- Bridges results back to JS via the standard Expo Modules async function bridge.

Roughly 100–150 lines of Swift. Follows the same EAS / Pods / config-plugin pattern as `native/ShareExtension/`.

### `modules/processing/` — new TS module

The OCR orchestrator and the only writer of `screenshots.ocr_text` and `screenshots.ocr_status` outside migrations.

Public surface:

```ts
export function enqueueOcr(screenshotId: string): void;
export function runOcrSweep(db: Database): Promise<void>;
```

Internals:

- A module-level singleton serial queue: `let chain: Promise<void> = Promise.resolve();` plus a `Set<string>` of in-flight / queued IDs to dedupe. `enqueueOcr(id)` is a no-op if `id` is already in the set; otherwise it appends `() => processOne(id).finally(() => set.delete(id))` to the chain.
- `processOne(id)`: loads the row, calls `VisionOCR.recognizeText(file_path)`, and on success runs a single `UPDATE screenshots SET ocr_text = ?, ocr_status = 'done', updated_at = ?` then calls `notifyChange('screenshots')`.
- Retry counter: a `Map<string, number>` in-memory. On Vision failure, increment; if `< 3` re-enqueue (stays `pending` in DB); if `>= 3` `UPDATE screenshots SET ocr_status = 'failed'`. Counter resets when the app process dies, which means after a relaunch every `failed` row gets 3 fresh tries before being shelved again — the cheap retry-on-restart we want.
- `runOcrSweep(db)` queries `SELECT id FROM screenshots WHERE ocr_status IN ('pending', 'failed') AND deleted_at IS NULL ORDER BY captured_at ASC` and calls `enqueueOcr` for each. Both `pending` and `failed` are picked up — `failed` rows are flipped back to `pending` implicitly by the next `processOne` run (we just re-enter the lifecycle); we don't write `pending` proactively to avoid an extra round-trip.
- The module never holds the DB connection across an OCR call; it grabs `db` per write so a long Vision call can't block other writers.

Roughly 150–200 lines of TS, plus `__tests__/processing.test.ts` (see Testing).

### FTS triggers — new migration `0002_ocr_fts.ts`

```sql
CREATE TRIGGER IF NOT EXISTS screenshots_fts_ai AFTER INSERT ON screenshots
  WHEN NEW.deleted_at IS NULL AND NEW.ocr_text IS NOT NULL
  BEGIN
    INSERT INTO screenshots_fts(screenshot_id, content)
    VALUES (NEW.id, NEW.ocr_text);
  END;

CREATE TRIGGER IF NOT EXISTS screenshots_fts_au AFTER UPDATE OF ocr_text, deleted_at ON screenshots
  BEGIN
    DELETE FROM screenshots_fts WHERE screenshot_id = OLD.id;
    INSERT INTO screenshots_fts(screenshot_id, content)
      SELECT NEW.id, NEW.ocr_text
       WHERE NEW.deleted_at IS NULL AND NEW.ocr_text IS NOT NULL;
  END;

CREATE TRIGGER IF NOT EXISTS screenshots_fts_ad AFTER DELETE ON screenshots
  BEGIN
    DELETE FROM screenshots_fts WHERE screenshot_id = OLD.id;
  END;
```

Notes:

- `IF NOT EXISTS` so the migration is safe to re-apply.
- The `AFTER UPDATE OF ocr_text, deleted_at` clause means trip-reassignment, file-path changes, etc. do **not** rewrite the FTS row. Cheap.
- Soft-delete (`deleted_at` set) removes the row from the index. Restore would re-insert via the same trigger.
- v0.2 indexes `ocr_text` only. When tags / extracted places ship, this trigger is replaced by a wider one that builds the document from joins; that migration is part of *those* specs, not this one.

### `app/search.tsx` — new search screen

Pushed onto the Stack from `app/_layout.tsx` (alongside the existing `places/[id]`, `trips/[id]` etc.). No new tab.

Layout (top to bottom):

1. **Header:** native nav bar with "Cancel" left button (pops back); title is empty (the search field replaces it).
2. **Search field:** full-width `TextInput`, autofocused on mount, with a clear (`×`) affordance when non-empty. Standard iOS appearance via NativeWind.
3. **Trip filter chips:** horizontally-scrollable row. First chip is "All trips" (selected by default). Subsequent chips are each non-deleted trip, alphabetical. Tapping a chip toggles the filter. Hidden when there are zero trips.
4. **Body:** one of three states based on input + results:
   - **Empty input:** centered hint "Search your screenshots".
   - **Has input, has results:** `FlatList` of result rows.
   - **Has input, zero results:** centered "No matches for '<query>'".
5. **Result row:** thumbnail (left, 64×64), then a column of (a) trip badge (small pill: trip name or "Inbox"), (b) the highlighted snippet. Tapping pushes `places/[id]` — that's the existing screenshot-detail route (the `places/` name is historical and will eventually need disambiguation when v0.2's *extracted-places* feature lands, but renaming is not in scope of this spec).

Behavior:

- Input is debounced 200ms before issuing the query.
- Each non-empty input is normalized (trim, collapse whitespace) and tokenized on whitespace. Tokens are escaped (FTS5 special characters quoted) and joined with spaces; the **last** token gets a trailing `*` for prefix matching while typing. Example: typing `tonk` issues `MATCH 'tonk*'`; typing `maru tonk` issues `MATCH 'maru tonk*'`.
- The FTS query uses the `snippet()` function to extract a 16-token excerpt with match markers:

  ```sql
  SELECT s.id,
         s.file_path,
         s.trip_id,
         t.name AS trip_name,
         snippet(screenshots_fts, 1, char(2), char(3), '…', 16) AS snippet
    FROM screenshots_fts
    JOIN screenshots s ON s.id = screenshots_fts.screenshot_id
    LEFT JOIN trips t ON t.id = s.trip_id AND t.deleted_at IS NULL
   WHERE screenshots_fts MATCH ?
     AND s.deleted_at IS NULL
     {trip_filter_clause}
   ORDER BY rank
   LIMIT 50;
  ```

  We pass `char(2)` / `char(3)` (`STX` / `ETX`) as match markers because they're guaranteed not to appear in OCR text. The TS layer splits on those bytes to render a `<Text>` with bold runs, no HTML parsing needed.
- `{trip_filter_clause}` is empty when "All trips" is selected, otherwise `AND s.trip_id = ?` with the selected trip's id bound.
- The query is `useLiveQuery`-backed so a screenshot whose OCR completes while the user has the search screen open will appear without a re-issue.
- A 50-row hard limit covers the v0.2 dataset comfortably; pagination is not in scope.

### Magnifier entry points

Add a header right button (magnifier icon) to:

- `app/(tabs)/index.tsx` (Inbox).
- `app/trips/[id].tsx` (trip detail).

Both push the same `app/search.tsx` route. The pre-selected trip filter chip is "All trips" in both cases — search is global. Honouring the launch context (e.g. pre-selecting the trip filter when launched from a trip) is tempting but adds a small surprise where users who want to escape the trip have to deselect a chip; "All trips" by default is the simpler answer.

### `ScreenshotThumbnail` shimmer

Wherever the existing list/grid rows render a thumbnail (Inbox, trip detail, search results), the row already has the `ocr_status` column from its source query (or it gains it — the queries widen to include it). When `ocr_status === 'pending'`, the thumbnail wraps in a NativeWind `animate-pulse` view with a translucent gray overlay (`bg-black/10`). On `'done'` or `'failed'`, render normally.

Search-result rows don't show the shimmer — by definition a result has `ocr_text`, so it's already `'done'` or close to it.

### `modules/capture/importImage.ts` — TS type widening

`source: 'share' | 'manual'` becomes `'share' | 'manual' | 'auto'`. No new code paths; just stops the type system from rejecting the auto-detect spec when it lands.

After the new screenshot row is inserted, `importImage` calls `processing.enqueueOcr(screenshotId)` before returning. This is non-blocking; the `importImage` call resolves immediately. (Care: don't enqueue when the result is `duplicate` — the existing row already has its own OCR lifecycle.)

## Data flow

### Lifecycle of a single screenshot's OCR

```
import (any source) ──▶ row inserted, ocr_status='pending'
                              │
                              │ importImage calls processing.enqueueOcr(id)
                              ▼
                     queued in serial chain
                              │
                              ▼ (when chain reaches it)
                     VisionOCR.recognizeText(file_path)
                              │
              ┌───────────────┴───────────────┐
              │                               │
            success                         failure
              │                               │
              ▼                               ▼
   ocr_text = result,                retryCount++
   ocr_status = 'done'                  │
   FTS trigger inserts                  ├─ retryCount < 3 → re-enqueue (stays 'pending')
   into screenshots_fts                 │
                                        └─ retryCount >= 3 → UPDATE ocr_status = 'failed'
                                                                  │
                                                                  ▼
                                                       picked up by next foreground sweep
                                                       (in-memory counter has reset on relaunch)
```

### Triggers vs. paths in the queue

- **Import-time path.** New row inserted (share, manual, future auto). `importImage` enqueues. The thumbnail in Inbox starts shimmering immediately.
- **Foreground sweep path.** `app/_layout.tsx`'s existing AppState `'active'` listener (today calling `ingestPendingImports`) gets a sibling call to `processing.runOcrSweep(db)`. This catches:
  - Items inserted by the share extension while the app was closed (the share extension never runs OCR; iOS extensions have ~120 MB and a few seconds — not enough).
  - Items left `pending` because the app crashed mid-OCR.
  - Items left `failed` from prior sessions that we want to retry once more.

Both paths feed the same module-level queue, and the queue dedupes on `screenshotId`. So even if import-time enqueue and a sweep both target the same id (they generally won't — the row from a sweep is older than any newly imported row by definition), only one OCR call runs.

## State & retry policy

| State | Semantics | Transitions |
|---|---|---|
| `pending` | OCR not yet attempted (or attempt in flight). | → `done` on success. → `failed` after 3 in-memory retries within the current app session. |
| `done` | `ocr_text` populated, FTS row exists. | → `pending` only via `ocr_text = NULL` (we don't do this in v0.2). |
| `failed` | 3 in-session retries exhausted. | → re-tried on next foreground sweep with a fresh in-memory counter; if it succeeds, flips to `done`; if it fails 3× again, returns to `failed`. |

3 in-memory retries comes from ARCHITECTURE.md's open question ("start at 3"). Re-trying `failed` rows on every relaunch is intentional: a screenshot that genuinely can't be OCR'd (corrupted file, unsupported format) will cycle silently and never reach the user. A transient fault (low memory, file not yet on disk) self-heals on the next launch.

## UI states

| Screen | State | Behavior |
|---|---|---|
| Inbox / Trip detail | `ocr_status='pending'` | Thumbnail shimmers (`animate-pulse` + `bg-black/10` overlay). Everything else (tap to open, drag to reorder if any, etc.) works normally. |
| Inbox / Trip detail | `'done'` or `'failed'` | Normal thumbnail. No visible difference between done and failed. |
| Search screen | empty input | Centered "Search your screenshots" hint. |
| Search screen | input + zero rows | Centered "No matches for '<query>'". |
| Search screen | input + rows | `FlatList` of result rows with snippet highlighting. |
| Header right (Inbox + Trip detail) | always | Magnifier icon → push `search`. |

OCR failures are silent in user-visible UI — same posture as ARCHITECTURE.md's "OCR failures: silent in UI." Sentry is not yet wired (it lands in v0.3); when it is, `processing` calls `telemetry.captureError(err, { screenshotId })` on each failure, but adding that hook is not part of this spec.

## Backfill & migration

Two flavors of pre-existing data on first launch of this version:

1. **Rows already in `screenshots`.** They have `ocr_status = 'pending'` (schema default since day one) but no OCR text. The first foreground sweep after this ships will pick them up and process them serially in the background. No special migration code; the lifecycle handles it.
2. **`screenshots_fts` has no triggers attached yet.** The new migration adds them. It does **not** backfill `screenshots_fts` from existing rows — it doesn't need to, because (1) no existing row has `ocr_text` set, so there's nothing to insert, and (2) once OCR completes for each row, the `AFTER UPDATE OF ocr_text` trigger fires and inserts the FTS row at that point.

Implication: search returns nothing on first launch and gradually populates as the foreground sweep drains. That's the right ordering — the user shouldn't see partial / lying results.

## Failure modes

| Case | Behavior |
|---|---|
| Vision throws (decode error, missing file). | Treated as failure; retry per policy. The screenshot itself is still browsable. |
| Image file deleted between insert and OCR (storage-full eviction; user manually clears app data). | Vision throws "file not found". Lifecycle marks `failed`. Soft-delete on the screenshot row removes it from FTS via the `AFTER DELETE` trigger. |
| App killed mid-OCR. | Row stays `pending`. Next foreground sweep re-queues it. No persisted in-flight state. |
| Two captures arrive within milliseconds (e.g. a shared item ingested at the same time as a manual import). | Both get enqueued. Queue is serial — one waits. No race. |
| FTS row inserted twice (defensive trigger fires unexpectedly). | The triggers always `DELETE` before `INSERT`, so duplicates are impossible. |
| User searches a query like `"O'Brien"` containing an FTS5 special character (apostrophe). | The token escaper wraps each token in `"…"` if it contains punctuation, falling back to a literal MATCH. Worst case: zero results, which is the FTS5 default for unparseable queries. |
| User types a query, then immediately taps Cancel before the 200ms debounce fires. | The pending query is cancelled by `useLiveQuery`'s teardown when the screen unmounts. |

## Open questions / decisions made

Resolved (recorded here so the implementation plan doesn't reopen them):

| Question | Decision |
|---|---|
| Trigger model for OCR (Q1) | Hybrid: import-time kickoff + foreground sweep. |
| Locale handling (Q2) | `automaticallyDetectsLanguage = true`. Overrides ARCHITECTURE.md's "start with device locale" lean. |
| UI feedback while pending (Q3) | List shimmer on the thumbnail. No detail-view pill. |
| Spec scope (Q4) | OCR plumbing + full search UX (highlighting + trip filter chip). |
| Search nav placement (Q5) | Magnifier in Inbox + Trip detail headers → dedicated `search` screen. |
| Retry count | 3 in-memory, resets per app launch. |
| FTS document content | `ocr_text` only. Trip name reached via `JOIN trips`. Tags / extracted places folded in by their own specs. |
| Result list cap | 50, no pagination. |
| Snippet length | 16 tokens, ellipsis-trimmed. |

Deferred to later specs:

- AI extraction (next v0.2 spec).
- Auto-detect (after AI extraction).
- Tags + tag chip filter on search.
- Per-screenshot "place detected" badge (extraction spec).
- `BGTaskScheduler` for true background OCR (deferred indefinitely; revisit if beta users complain).
- Sentry / `telemetry.captureError` wiring for OCR failures (lands with v0.3 telemetry).

## Testing

**Unit tests (Jest, in `modules/processing/__tests__/`):**

- `processOne` happy path: stub `VisionOCR.recognizeText` → assert `ocr_text` and `ocr_status='done'` written, `notifyChange('screenshots')` fired.
- Failure + retry: stub Vision to throw 3 times → assert third failure flips `ocr_status='failed'` and the in-memory counter is at 3 for that id.
- Retry resets across "relaunch" by re-importing the module (or exposing a test-only reset).
- Queue dedup: two concurrent `enqueueOcr(id)` calls only invoke Vision once.
- Queue serialization: two `enqueueOcr(idA)` + `enqueueOcr(idB)` with a Vision stub that delays should observe `idA` complete before `idB` starts.
- `runOcrSweep` picks up both `pending` and `failed` rows ordered by `captured_at ASC`.

**Unit tests (Jest, in `modules/storage/__tests__/`):**

- New migration applies cleanly on a fresh DB and on a pre-existing v0.1 DB.
- After inserting a `screenshots` row with `ocr_text`, the FTS row exists.
- After updating `ocr_text` on an existing row, the FTS row reflects the new content (not duplicated).
- After soft-deleting a screenshot, the FTS row is gone.
- A search query (`screenshots_fts MATCH 'hello'`) returns the right row.

**Search query unit tests** (`app/__tests__/searchQuery.test.ts` or co-located with the helper):

- Empty/whitespace input → no query issued.
- Single token → `'tok*'`.
- Multiple tokens → `'foo bar baz*'` (last gets `*`).
- Special characters (apostrophe, quote) → wrapped in double quotes, no SQL injection.
- Trip filter id is bound as a parameter (no string-concat).

**Native module — manual smoke test on device:**

- Capture a screenshot in Vietnamese; foreground app; verify search hit on Vietnamese token.
- Capture a Japanese restaurant menu screenshot; foreground app; verify search hit on Japanese token.
- Force-quit during OCR; relaunch; verify the row processes on next foreground.
- Same posture as `native/ShareExtension/`: no XCTest, the cost / value is wrong for solo dev.

**E2E:** out of scope (Maestro deferred per ARCHITECTURE.md).

## File-change inventory

**New:**

- `native/VisionOCR/` — Swift Expo Module (Package.swift, expo-module.config.json, Sources/VisionOCRModule.swift, ios/VisionOCR.podspec, etc.).
- `plugins/with-vision-ocr.js` — config plugin to register the module with prebuild (or the simpler Expo-Modules-autolink path if we don't need any Info.plist tweaks; TBD at plan time).
- `modules/processing/index.ts`, `modules/processing/processing.ts`, `modules/processing/__tests__/processing.test.ts`.
- `modules/storage/migrations/0002_ocr_fts.ts`.
- `app/search.tsx`.

**Modified:**

- `modules/capture/importImage.ts` — widen `source` type; call `processing.enqueueOcr` after a successful insert (only on `imported`, not `duplicate`).
- `modules/storage/migrations/index.ts` — register the new migration.
- `modules/storage/screenshots.ts` — list / detail queries widen to include `ocr_status` so the shimmer can render.
- `app/_layout.tsx` — add `processing.runOcrSweep(ctx.db)` to the same foreground effect that runs `ingestPendingImports`.
- `app/(tabs)/index.tsx` — add header magnifier; ensure thumbnail rows render the shimmer when `ocr_status='pending'`.
- `app/trips/[id].tsx` — add header magnifier; same shimmer treatment in the grid.
- `app/_components/` — extract or update `ScreenshotThumbnail` to encapsulate the pending shimmer.

**Deleted:** none.

## Implementation order suggestion (for the plan)

1. Migration + storage tests (FTS triggers) — pure SQL, smallest blast radius, lets later steps assume FTS works.
2. Native VisionOCR module (skeleton + smoke test on device).
3. `modules/processing` with the serial queue and retry, against a JS stub of VisionOCR — unit-tested before any device wiring.
4. Wire processing into `importImage` + `app/_layout.tsx`. Smoke on device.
5. Thumbnail shimmer.
6. Search screen — query helper first (unit-tested), then UI.
7. Magnifier entry points.

## Sequencing note

After this ships, the next v0.2 spec is **AI extraction**, which:

- Consumes `ocr_text` from `screenshots` where `extraction_status = 'pending'` AND `ocr_status = 'done'`.
- Adds a similar pipeline (`modules/extraction`) that calls a thin proxy.
- Decides per-screenshot whether to surface it (≥1 extracted place) — this is the "classifier" auto-detect leans on.
- Expands the FTS document to include extracted place names (replacing the trigger introduced here).

Auto-detect is the third and last spec for the v0.2 sequenced pipeline.
