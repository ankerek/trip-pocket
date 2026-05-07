# Share-Extension Trip Picker — Design

**Date:** 2026-05-07
**Status:** approved, ready for implementation plan
**Roadmap:** closes the last outstanding item from Phase 2 ("trip picker UI in *both* the share extension and the app"). After this, v0.1 "Now + Next" is fully done.

## Goal

Replace the share extension's hard-coded "Save to Inbox" button with a list picker so the user can route a shared screenshot directly into a specific trip, without the app round-trip to reassign.

## Non-goals

- Creating a new trip from the share extension. The in-app picker has inline create; the share extension intentionally does not. Saving to Inbox + reassigning in-app is the escape hatch when no fitting trip exists.
- Per-trip color, count, or recency hints in the list.
- Changing JS-side ingestion. `ingestPendingImports` already honors `pending_imports.suggested_trip_id`.
- Testing infrastructure for Swift code (XCTest under EAS). Smoke testing on a real device is the verification.

## Context

Today the extension shows a single "Save to Inbox" button. It writes a row to `pending_imports` with `suggested_trip_id = NULL`, copies the image to the App Group container, and dismisses. The main app drains `pending_imports` on foreground via `ingestPendingImports`.

The schema already supports per-import trip targeting (`pending_imports.suggested_trip_id`), and `importImage` already routes to that trip when present. The missing piece is the Swift UI and a Swift read-path against the `trips` table.

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
- `native/ShareExtension/TripReader.swift` — reads non-deleted rows from `trips`, returns `[Trip]` (id + name only). Mirrors `PendingImportWriter`'s SQLite-C style. Read-only.
- `native/ShareExtension/TripPickerView.swift` — SwiftUI list view. Replaces `SaveButtonView`.

**Modified:**
- `native/ShareExtension/PendingImportWriter.swift` — `write(imageAt:)` becomes `write(imageAt:suggestedTripId:)`. Binds the id when non-nil, `NULL` otherwise.
- `native/ShareExtension/ShareViewController.swift` — hosts `TripPickerView`; `handleSave` accepts `tripId: String?` and passes it to the writer.

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

## Cross-process SQLite — Phase 1 risk note

This change adds a **read** of `trips` from the extension. The extension previously only wrote `pending_imports`. Risks:

- **WAL mode is already on.** `PendingImportWriter` sets `PRAGMA journal_mode = WAL` on first open and the setting persists per-database. Concurrent readers + writers are safe under WAL.
- **No blocking on held writers.** A reader gets a snapshot; worst case is the picker shows a slightly stale trip list if the main app is mid-transaction. Milliseconds-stale is acceptable here — user tapped share, wants a list, doesn't care about freshness in human time.
- **Extension stays write-only against `trips`** — `TripReader` is strictly read-only. The "no create-new in the extension" decision (locked above) keeps it that way; no new write contention.

## Verification plan

Manual smoke test on a real iPhone after a fresh EAS dev build. Setting up Swift XCTest under EAS for a single read function is more scaffolding than the tests would catch. JS side has no changes, so no new JS tests.

1. **Fresh install** (delete app, reinstall) → share a screenshot → picker shows "Inbox" only → tap → opens app, screenshot in Inbox. Confirms graceful fallback when no trips exist.
2. **With trips** — create 2–3 trips in-app → share a screenshot → picker shows "Inbox" + alphabetical trips → tap a trip → opens app, screenshot in that trip.
3. **Inbox path** — tap "Inbox" row → screenshot in Inbox.
4. **Cancel path** — tap Cancel → no row written, no image copied.
5. **Repeatability** — repeat #2 three times in a row → same trip every time, no flakiness.

## Out of scope (deferred)

- "Create new trip" inline in the extension. Reconsider only if user testing surfaces a real pain point (rare in practice — most captures happen for trips that already exist).
- Per-trip thumbnails / counts in the picker. Wait for a real reason.
- Default-to-last-used-trip with a "change" affordance. Premature; revisit after we have usage data on whether repeat-capture-into-one-trip is common.

## Implementation budget

- Two new Swift files (~50–80 LOC each).
- Two existing Swift files modified.
- One file deleted.
- One EAS dev build round-trip (budget one round of "build fails, debug, rebuild" per Phase 1's risk note).
- No JS changes.
