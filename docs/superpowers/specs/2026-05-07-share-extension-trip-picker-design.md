# Share-Extension Trip Picker — Design

**Date:** 2026-05-07
**Status:** approved, ready for implementation plan
**Roadmap:** closes the last outstanding item from Phase 2 ("trip picker UI in *both* the share extension and the app"). After this, v0.1 "Now + Next" is fully done.

## Goal

Replace the share extension's hard-coded "Save to Inbox" button with a list picker so the user can route a shared screenshot directly into a specific trip, without the app round-trip to reassign.

## Non-goals

- Creating a new trip from the share extension. The in-app picker has inline create; the share extension intentionally does not. Saving to Inbox + reassigning in-app is the escape hatch when no fitting trip exists.
- Per-trip color, count, or recency hints in the list.
- Programmatically opening the containing app from the extension. Share extensions can't reliably foreground a host app and App Store review treats that pattern as a misuse. The user opens the app the next time they use it; ingestion drains on foreground as it does today.
- Testing infrastructure for Swift code (XCTest under EAS). Smoke testing on a real device is the verification.

## Context

Today the extension shows a single "Save to Inbox" button. It writes a row to `pending_imports` with `suggested_trip_id = NULL`, copies the image to the App Group container, and dismisses. The main app drains `pending_imports` on foreground via `ingestPendingImports`.

The schema already supports per-import trip targeting (`pending_imports.suggested_trip_id`), and `importImage` already routes to that trip when present. The missing piece is the Swift UI and a Swift read-path against the `trips` table — plus a small ingest-time guard against stale-trip selections (see "Stale trip selection" below).

## Architecture

```
[Photos share sheet]
       │
       ▼
ShareViewController                    ── existing, modified to host new view
       │  loads UIHostingController
       ▼
TripPickerView (NEW)                   ── replaces SaveButtonView
   ├─ on appear: TripReader().listTrips() → [Trip]
   ├─ renders: "Inbox" row + alphabetical trips
   ├─ on tap row → handleSave(tripId: String?)
   └─ on cancel → cancelRequest
       │
       ▼
PendingImportWriter                    ── existing, signature extended
   write(imageAt: URL, suggestedTripId: String?)
       │  copies image to App Group
       │  INSERT into pending_imports with suggestedTripId or NULL
       ▼
extensionContext.completeRequest()

[Later, main app foregrounds]
       ▼
ingestPendingImports                   ── existing, no changes; already honors suggested_trip_id
```

### File changes

**New:**
- `native/ShareExtension/TripReader.swift` — reads non-deleted rows from `trips`, returns `[Trip]` (id + name only). Read-only (see "TripReader read-only contract" below).
- `native/ShareExtension/TripPickerView.swift` — SwiftUI list view. Replaces `SaveButtonView`.

**Modified:**
- `native/ShareExtension/PendingImportWriter.swift` — `write(imageAt:)` becomes `write(imageAt:suggestedTripId:)`. Binds the id when non-nil, `NULL` otherwise.
- `native/ShareExtension/ShareViewController.swift` — hosts `TripPickerView`; `handleSave` accepts `tripId: String?` and passes it to the writer.
- `plugins/with-share-extension.js` — the `PBXSourcesBuildPhase` source list is hard-coded (currently lists `ShareViewController.swift`, `SaveButtonView.swift`, `PendingImportWriter.swift`). Update to: `ShareViewController.swift`, `TripPickerView.swift`, `PendingImportWriter.swift`, `TripReader.swift`. Without this, a fresh prebuild keeps compiling the deleted file and omits the new ones from the target.
- `modules/capture/ingest.ts` — small guard: if a pending row's `suggested_trip_id` no longer points at an active (non-soft-deleted, existing) trip at drain time, fall back to `null` (Inbox). See "Stale trip selection" below.

**Deleted:**
- `native/ShareExtension/SaveButtonView.swift`.

### Inbox row

Inbox is rendered as a regular list row labeled "Inbox" at the top, with a thin separator below it before the trip list. Tapping it calls `handleSave(tripId: nil)` so the existing NULL-means-Inbox semantics carry over without any new column.

### Trip ordering

Alphabetical (`name COLLATE NOCASE ASC`) — matches the in-app `TripPicker` so the two surfaces are consistent.

## Failure modes

`TripReader.listTrips()` returns `[]` and the picker shows Inbox-only in all of these:

| Case | Why |
|---|---|
| DB file doesn't exist yet | Extension ran before the app's first launch ever. `trips` table can't exist; we explicitly do not create it defensively (main app owns the schema). |
| `trips` table doesn't exist | Older build / pre-v0001 schema. Treat any `sqlite3_prepare_v2` error as "no trips". |
| DB locked / read fails mid-query | Picker still shows Inbox; user can save. |

A fresh install (no trips yet) and any error path look identical to the user — they always have at least the Inbox row. No error UI is shown.

## TripReader read-only contract

`TripReader` opens the App Group DB with `sqlite3_open_v2(path, &db, SQLITE_OPEN_READONLY, nil)`. Two reasons:

1. **Doesn't create the DB file.** Plain `sqlite3_open` creates the file if missing — that would make the extension produce an empty DB before the main app's first launch ever ran a migration, and the next main-app launch would see a non-empty file and could mis-handle it. Read-only open returns `SQLITE_CANTOPEN` instead, which we catch and treat as "no trips".
2. **Backs the read-only claim with the SQLite API itself**, not just convention. Any future copy-paste of this code can't accidentally mutate `trips`.

Add `sqlite3_busy_timeout(db, 200)` (200 ms) so a transient lock from the main app doesn't fail the read instantly — still well inside human-interactive latency, and we fall back to Inbox-only if the read times out.

## Stale trip selection

Between the user picking a trip in the extension and the main app draining `pending_imports`, the trip can be deleted. If we insert blindly with that `suggested_trip_id`, the screenshot ends up attached to a soft-deleted trip — invisible in both Inbox and the trip detail view. That's an orphaned state, not acceptable.

**Fix at ingest, not at extension.** The extension can't hold a lock across processes, and even with the busy timeout it would race. The ingest path already runs serially in the main app and already does the `screenshots` insert — it's the right place to validate.

In `ingestPendingImports`, before calling `importImage`, check whether `suggested_trip_id` (when non-null) refers to an active trip:

```sql
SELECT 1 FROM trips WHERE id = ? AND deleted_at IS NULL
```

If the row is missing, pass `suggestedTripId: null` to `importImage` so the screenshot lands in Inbox. The pending row is still drained either way. No user-facing error — Inbox is a graceful, expected destination.

This is the only JS change in the spec.

## Cross-process SQLite — Phase 1 risk note

This change adds a **read** of `trips` from the extension. The extension previously only wrote `pending_imports`. Risks:

- **WAL mode is already on.** `PendingImportWriter` sets `PRAGMA journal_mode = WAL` on first open and the setting persists per-database. Concurrent readers + writers are safe under WAL.
- **No blocking on held writers.** A reader gets a snapshot; worst case is the picker shows a slightly stale trip list if the main app is mid-transaction. Milliseconds-stale is acceptable here — user tapped share, wants a list, doesn't care about freshness in human time.
- **Extension stays write-only against `trips`** — `TripReader` is strictly read-only. The "no create-new in the extension" decision (locked above) keeps it that way; no new write contention.

## Verification plan

Manual smoke test on a real iPhone after a fresh EAS dev build. Setting up Swift XCTest under EAS for a single read function is more scaffolding than the tests would catch. JS side gets unit-test coverage for the stale-trip ingest guard's three branches (stale id, missing id, live id); the rest is on-device.

**Important:** the share extension cannot programmatically open the host app, and we don't try to. After tapping a trip, the extension dismisses. To verify the screenshot landed correctly, the user manually opens Trip Pocket — the foreground triggers `ingestPendingImports`.

1. **Fresh install** (delete app, reinstall) → share a screenshot → picker shows "Inbox" only → tap → extension dismisses. Open Trip Pocket → screenshot in Inbox. Confirms graceful fallback when no trips exist.
2. **With trips** — create 2–3 trips in-app → share a screenshot → picker shows "Inbox" + alphabetical trips → tap a trip → extension dismisses. Open Trip Pocket → screenshot in that trip.
3. **Inbox path** — tap "Inbox" row → open app → screenshot in Inbox.
4. **Cancel path** — tap Cancel → no row written, no image copied. Open app → no new screenshot.
5. **Repeatability** — repeat #2 three times in a row → same trip every time, no flakiness.
6. **Stale trip (one-off, optional but worth doing once)** — share a screenshot to trip "X". *Before* opening the app, delete trip "X" via in-app trip delete… well, the app must be open to delete. Practical version: jest-test the ingest guard directly. The unit test creates a pending row with a `suggested_trip_id` pointing at a soft-deleted trip and asserts the resulting screenshot has `trip_id = null`.

**Three JS tests added** (`modules/capture/__tests__/ingest.test.ts`), one per branch of the new guard: stale (soft-deleted) trip falls back to Inbox, missing-id trip falls back to Inbox, live-trip id passes through unchanged. The live-trip case is a regression guard against accidentally falling back when the trip is healthy.

## Out of scope (deferred)

- "Create new trip" inline in the extension. Reconsider only if user testing surfaces a real pain point (rare in practice — most captures happen for trips that already exist).
- Per-trip thumbnails / counts in the picker. Wait for a real reason.
- Default-to-last-used-trip with a "change" affordance. Premature; revisit after we have usage data on whether repeat-capture-into-one-trip is common.

## Implementation budget

- Two new Swift files (~50–80 LOC each).
- Two existing Swift files modified.
- One file deleted.
- One config plugin updated (`plugins/with-share-extension.js` source list).
- One small JS guard added to `ingestPendingImports`, with three new unit tests (one per branch).
- One EAS dev build round-trip (budget one round of "build fails, debug, rebuild" per Phase 1's risk note).
