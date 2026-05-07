# Share-Extension Trip Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the share extension's hard-coded "Save to Inbox" button with a SwiftUI list picker so a shared screenshot can be routed directly into a specific trip — closing the last outstanding Phase 2 item.

**Architecture:** New SwiftUI `TripPickerView` reads non-deleted trips from the App Group SQLite via a new read-only `TripReader`, and on tap calls the existing `PendingImportWriter` (extended to accept an optional `suggestedTripId`). The JS-side `ingestPendingImports` already honors `pending_imports.suggested_trip_id`; one small ingest-time guard is added so that a trip soft-deleted between picker and drain falls back gracefully to Inbox instead of orphaning the screenshot.

**Tech Stack:** Swift 5 + SwiftUI, SQLite3 C API (read-only), TypeScript / `expo-sqlite` on the JS side, Jest for unit tests, EAS dev build for on-device verification.

**Spec:** `docs/superpowers/specs/2026-05-07-share-extension-trip-picker-design.md`.

---

## File map

| File | Status | Responsibility |
|---|---|---|
| `modules/capture/ingest.ts` | modify | Skip stale `suggested_trip_id` (soft-deleted or missing) — fall back to Inbox |
| `modules/capture/__tests__/ingest.test.ts` | modify | New test: stale trip falls back to Inbox |
| `native/ShareExtension/PendingImportWriter.swift` | modify | `write(imageAt:suggestedTripId:)` — bind id or NULL |
| `native/ShareExtension/TripReader.swift` | create | Read-only `[Trip]` from App Group DB |
| `native/ShareExtension/TripPickerView.swift` | create | SwiftUI list — "Inbox" + alphabetical trips |
| `native/ShareExtension/ShareViewController.swift` | modify | Host `TripPickerView`, plumb tripId to writer |
| `native/ShareExtension/SaveButtonView.swift` | delete | Replaced by `TripPickerView` |
| `plugins/with-share-extension.js` | modify | Update `PBXSourcesBuildPhase` source list |

---

## Task 1: JS ingest-time stale-trip guard

**Why first:** The guard is a safety net for the new code path, fully testable in Jest, and independent of any Swift work. Land it before any user can hit the picker.

**Files:**
- Modify: `modules/capture/ingest.ts`
- Test: `modules/capture/__tests__/ingest.test.ts`

- [ ] **Step 1: Write the failing test**

Append this test inside the existing `describe('ingestPendingImports', ...)` block in `modules/capture/__tests__/ingest.test.ts`:

```typescript
it('falls back to Inbox when suggested_trip_id points to a soft-deleted trip', async () => {
  const db = await freshDb();
  // Insert a trip and soft-delete it to simulate the race.
  await db.runAsync(
    `INSERT INTO trips (id, name, owner_id, created_at, updated_at, deleted_at)
     VALUES ('t-gone', 'Old Trip', ?, '2026-05-01T00:00:00Z', '2026-05-01T00:00:00Z', '2026-05-06T00:00:00Z')`,
    ownerId,
  );
  // Pending import targeting the now-deleted trip.
  await db.runAsync(
    `INSERT INTO pending_imports (id, app_group_path, suggested_trip_id, created_at)
     VALUES ('p1', '/appgroup/img1.jpg', 't-gone', '2026-05-07T10:00:00Z')`,
  );

  const fs = makeFs();
  await ingestPendingImports(db, { ownerId, sandboxDir: '/sandbox', fs });

  // Screenshot should land in Inbox (trip_id IS NULL), not on the deleted trip.
  const inbox = await listScreenshots(db, { tripId: null });
  expect(inbox).toHaveLength(1);
  expect(inbox[0]?.tripId).toBeNull();

  // And the pending row was drained.
  expect(await db.getAllAsync('SELECT * FROM pending_imports')).toEqual([]);
});

it('falls back to Inbox when suggested_trip_id refers to a missing trip row', async () => {
  const db = await freshDb();
  // No trip with this id ever existed.
  await db.runAsync(
    `INSERT INTO pending_imports (id, app_group_path, suggested_trip_id, created_at)
     VALUES ('p1', '/appgroup/img1.jpg', 't-missing', '2026-05-07T10:00:00Z')`,
  );

  const fs = makeFs();
  await ingestPendingImports(db, { ownerId, sandboxDir: '/sandbox', fs });

  const inbox = await listScreenshots(db, { tripId: null });
  expect(inbox).toHaveLength(1);
  expect(inbox[0]?.tripId).toBeNull();
});

it('preserves suggested_trip_id when it points to an active trip', async () => {
  const db = await freshDb();
  await db.runAsync(
    `INSERT INTO trips (id, name, owner_id, created_at, updated_at)
     VALUES ('t-live', 'Japan', ?, '2026-05-01T00:00:00Z', '2026-05-01T00:00:00Z')`,
    ownerId,
  );
  await db.runAsync(
    `INSERT INTO pending_imports (id, app_group_path, suggested_trip_id, created_at)
     VALUES ('p1', '/appgroup/img1.jpg', 't-live', '2026-05-07T10:00:00Z')`,
  );

  const fs = makeFs();
  await ingestPendingImports(db, { ownerId, sandboxDir: '/sandbox', fs });

  const onTrip = await listScreenshots(db, { tripId: 't-live' });
  expect(onTrip).toHaveLength(1);
  expect(onTrip[0]?.tripId).toBe('t-live');
});
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `npx jest modules/capture/__tests__/ingest.test.ts -t "falls back to Inbox" -t "preserves suggested_trip_id"`

Expected: at least one of the new cases fails (the soft-deleted-trip case will currently insert with `trip_id = 't-gone'`, so `tripId` will not be `null`).

- [ ] **Step 3: Add the guard in `ingest.ts`**

Replace the body of the `for (const p of pending) { ... }` loop in `modules/capture/ingest.ts` with the version below. The only change vs. current code is the `suggestedTripId` resolution before `importImage`.

```typescript
for (const p of pending) {
  try {
    let suggestedTripId = p.suggested_trip_id;
    if (suggestedTripId !== null) {
      // Trip may have been soft-deleted (or never existed) between when the
      // share extension wrote the pending row and now. Falling back to Inbox
      // beats orphaning the screenshot on a deleted trip.
      const live = await db.getFirstAsync<{ id: string }>(
        `SELECT id FROM trips WHERE id = ? AND deleted_at IS NULL`,
        suggestedTripId,
      );
      if (!live) suggestedTripId = null;
    }

    await importImage(db, {
      sourceUri: p.app_group_path,
      source: 'share',
      ownerId: opts.ownerId,
      capturedAt: p.created_at,
      suggestedTripId,
      transfer: 'move',
      sandboxDir: opts.sandboxDir,
      fs: opts.fs,
    });
    // Both 'imported' and 'duplicate' are terminal: drain the pending row.
    await db.runAsync('DELETE FROM pending_imports WHERE id = ?', p.id);
    committed += 1;
  } catch (err) {
    console.warn('[ingestPendingImports] row failed', p.id, err);
  }
}
```

- [ ] **Step 4: Re-run the ingest test file to verify all tests pass**

Run: `npx jest modules/capture/__tests__/ingest.test.ts`

Expected: all tests pass — the three new ones plus the four pre-existing ones.

- [ ] **Step 5: Commit**

```sh
git add modules/capture/ingest.ts modules/capture/__tests__/ingest.test.ts
git commit -m "feat(ingest): drop stale suggested_trip_id, fall back to Inbox

If a trip is soft-deleted (or never existed) between when the share
extension writes a pending_imports row and when the main app drains
it, the screenshot would otherwise be attached to a dead trip and
disappear from both Inbox and the trip detail view. Validate against
trips.deleted_at at drain time and fall back to trip_id = NULL."
```

---

## Task 2: Add `TripReader.swift`

**Files:**
- Create: `native/ShareExtension/TripReader.swift`

**Read-only contract:** opens with `SQLITE_OPEN_READONLY` so the file isn't created when missing; returns `[]` on any error path. Does not throw.

- [ ] **Step 1: Create the file**

```swift
import Foundation
import SQLite3

struct TripReader {
    let appGroupId = "group.com.trippocket.shared"

    struct Trip {
        let id: String
        let name: String
    }

    func listTrips() -> [Trip] {
        guard let groupURL = FileManager.default
            .containerURL(forSecurityApplicationGroupIdentifier: appGroupId) else {
            return []
        }
        let dbURL = groupURL.appendingPathComponent("trip-pocket.db")

        var db: OpaquePointer?
        // Read-only open: returns SQLITE_CANTOPEN if the DB file is missing,
        // instead of creating an empty DB that the main app would then mistake
        // for a populated one on first launch.
        guard sqlite3_open_v2(dbURL.path, &db, SQLITE_OPEN_READONLY, nil) == SQLITE_OK else {
            return []
        }
        defer { sqlite3_close(db) }

        // 200 ms is well inside human-interactive latency; if the main app holds
        // a write longer than that we accept showing Inbox-only.
        sqlite3_busy_timeout(db, 200)

        let sql = """
            SELECT id, name FROM trips
            WHERE deleted_at IS NULL
            ORDER BY name COLLATE NOCASE ASC
        """
        var stmt: OpaquePointer?
        // prepare_v2 fails with SQLITE_ERROR if the trips table doesn't exist
        // (older schema); treat as "no trips".
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
            return []
        }
        defer { sqlite3_finalize(stmt) }

        var results: [Trip] = []
        while sqlite3_step(stmt) == SQLITE_ROW {
            guard let idCStr = sqlite3_column_text(stmt, 0),
                  let nameCStr = sqlite3_column_text(stmt, 1) else { continue }
            let id = String(cString: idCStr)
            let name = String(cString: nameCStr)
            results.append(Trip(id: id, name: name))
        }
        return results
    }
}
```

- [ ] **Step 2: Commit**

```sh
git add native/ShareExtension/TripReader.swift
git commit -m "feat(share): TripReader — read-only trips from App Group DB

Opens the shared SQLite read-only (SQLITE_OPEN_READONLY) so the
extension cannot accidentally create an empty DB before the main
app's first launch. 200 ms busy timeout. Returns [] on any error
so the picker degrades gracefully to Inbox-only."
```

---

## Task 3: Add `TripPickerView.swift`

**Files:**
- Create: `native/ShareExtension/TripPickerView.swift`

**UX contract:**
- One section titled "Save to" with an "Inbox" row at the top.
- A second section listing trips alphabetically, only when there are trips.
- Cancel button in the navigation bar (leading edge) calls `onCancel`.
- Tapping any row calls `onSave(_:)` with the chosen trip id (or `nil` for Inbox) — the parent dismisses.

- [ ] **Step 1: Create the file**

```swift
import SwiftUI

struct TripPickerView: View {
    let onSave: (String?) -> Void
    let onCancel: () -> Void

    @State private var trips: [TripReader.Trip] = []
    @State private var loaded = false

    var body: some View {
        NavigationView {
            List {
                Section {
                    Button(action: { onSave(nil) }) {
                        Text("Inbox")
                            .foregroundColor(.primary)
                    }
                }
                if !trips.isEmpty {
                    Section("Trips") {
                        ForEach(trips, id: \.id) { trip in
                            Button(action: { onSave(trip.id) }) {
                                Text(trip.name)
                                    .foregroundColor(.primary)
                            }
                        }
                    }
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle("Save to")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: onCancel)
                }
            }
        }
        .onAppear {
            // Load once; re-appear (e.g. from background) shouldn't re-query
            // and risk flicker. The extension is short-lived anyway.
            guard !loaded else { return }
            trips = TripReader().listTrips()
            loaded = true
        }
    }
}
```

- [ ] **Step 2: Commit**

```sh
git add native/ShareExtension/TripPickerView.swift
git commit -m "feat(share): TripPickerView — Inbox + alphabetical trips list"
```

---

## Task 4: Switchover — extend `PendingImportWriter`, rewire `ShareViewController`, delete `SaveButtonView`

**Why all in one commit:** these three changes are tightly coupled — extending the writer's signature breaks the call site, so the writer change and the call-site fix must land together. The `SaveButtonView` deletion piggybacks for the same reason (its absence would break `ShareViewController` if it still referenced it). One coherent commit; every commit on `main` compiles.

**Files:**
- Modify: `native/ShareExtension/PendingImportWriter.swift`
- Modify: `native/ShareExtension/ShareViewController.swift`
- Delete: `native/ShareExtension/SaveButtonView.swift`

**Note on testing:** Per the spec, the share extension has no Swift unit tests. Verification is "the file compiles and the new parameter binds correctly," covered end-to-end by the smoke test in Task 6. Don't add XCTest scaffolding.

- [ ] **Step 1: Update `PendingImportWriter.swift`**

Replace the body of `PendingImportWriter.swift` with the version below. Vs. current: the `write` signature gains `suggestedTripId: String?`, and the INSERT binds it (or NULL) into column 3.

```swift
import Foundation
import SQLite3

enum PendingImportError: Error {
    case noAppGroup
    case copyFailed
    case dbFailed
}

struct PendingImportWriter {
    let appGroupId = "group.com.trippocket.shared"

    func write(imageAt sourceURL: URL, suggestedTripId: String?) throws {
        guard let groupURL = FileManager.default
            .containerURL(forSecurityApplicationGroupIdentifier: appGroupId) else {
            throw PendingImportError.noAppGroup
        }

        let imagesDir = groupURL.appendingPathComponent("inbox", isDirectory: true)
        try? FileManager.default.createDirectory(at: imagesDir, withIntermediateDirectories: true)

        let destURL = imagesDir.appendingPathComponent(UUID().uuidString + ".jpg")
        do {
            try FileManager.default.copyItem(at: sourceURL, to: destURL)
        } catch {
            throw PendingImportError.copyFailed
        }

        let dbURL = groupURL.appendingPathComponent("trip-pocket.db")
        var db: OpaquePointer?
        guard sqlite3_open(dbURL.path, &db) == SQLITE_OK else {
            throw PendingImportError.dbFailed
        }
        defer { sqlite3_close(db) }

        sqlite3_exec(db, "PRAGMA journal_mode = WAL;", nil, nil, nil)

        let create = """
            CREATE TABLE IF NOT EXISTS pending_imports (
                id TEXT PRIMARY KEY NOT NULL,
                app_group_path TEXT NOT NULL,
                suggested_trip_id TEXT,
                created_at TEXT NOT NULL
            );
        """
        if sqlite3_exec(db, create, nil, nil, nil) != SQLITE_OK {
            throw PendingImportError.dbFailed
        }

        let insert = """
            INSERT INTO pending_imports (id, app_group_path, suggested_trip_id, created_at)
            VALUES (?, ?, ?, ?);
        """
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, insert, -1, &stmt, nil) == SQLITE_OK else {
            throw PendingImportError.dbFailed
        }
        defer { sqlite3_finalize(stmt) }

        let id = UUID().uuidString
        let createdAt = ISO8601DateFormatter().string(from: Date())
        let SQLITE_TRANSIENT = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
        sqlite3_bind_text(stmt, 1, id, -1, SQLITE_TRANSIENT)
        sqlite3_bind_text(stmt, 2, destURL.absoluteString, -1, SQLITE_TRANSIENT)
        if let tripId = suggestedTripId {
            sqlite3_bind_text(stmt, 3, tripId, -1, SQLITE_TRANSIENT)
        } else {
            sqlite3_bind_null(stmt, 3)
        }
        sqlite3_bind_text(stmt, 4, createdAt, -1, SQLITE_TRANSIENT)

        guard sqlite3_step(stmt) == SQLITE_DONE else {
            throw PendingImportError.dbFailed
        }
    }
}
```

- [ ] **Step 2: Replace `ShareViewController.swift`**

Only `viewDidLoad` (host the new view) and `handleSave` (carry a trip id) change vs. the current file. Image-loading and helpers are unchanged.

```swift
import UIKit
import SwiftUI
import UniformTypeIdentifiers

class ShareViewController: UIViewController {
    override func viewDidLoad() {
        super.viewDidLoad()
        let host = UIHostingController(rootView: TripPickerView(
            onSave: { [weak self] tripId in
                self?.handleSave(tripId: tripId)
            },
            onCancel: { [weak self] in
                self?.cancel()
            }
        ))
        addChild(host)
        view.addSubview(host.view)
        host.view.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            host.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            host.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            host.view.topAnchor.constraint(equalTo: view.topAnchor),
            host.view.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])
        host.didMove(toParent: self)
    }

    private func handleSave(tripId: String?) {
        guard let item = (extensionContext?.inputItems as? [NSExtensionItem])?.first,
              let provider = item.attachments?.first(where: { $0.hasItemConformingToTypeIdentifier(UTType.image.identifier) })
        else {
            cancel()
            return
        }
        provider.loadItem(forTypeIdentifier: UTType.image.identifier) { [weak self] data, _ in
            guard let self else { return }
            guard let url = self.materializeImage(data) else { self.cancel(); return }
            do {
                try PendingImportWriter().write(imageAt: url, suggestedTripId: tripId)
                DispatchQueue.main.async {
                    self.extensionContext?.completeRequest(returningItems: nil)
                }
            } catch {
                DispatchQueue.main.async { self.cancel() }
            }
        }
    }

    private func materializeImage(_ data: NSSecureCoding?) -> URL? {
        if let url = data as? URL { return url }
        if let raw = data as? Data, let img = UIImage(data: raw) {
            return writeJpegToTemp(img)
        }
        if let img = data as? UIImage {
            return writeJpegToTemp(img)
        }
        return nil
    }

    private func writeJpegToTemp(_ img: UIImage) -> URL? {
        guard let jpeg = img.jpegData(compressionQuality: 0.95) else { return nil }
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString + ".jpg")
        do {
            try jpeg.write(to: tmp)
            return tmp
        } catch {
            return nil
        }
    }

    private func cancel() {
        extensionContext?.cancelRequest(withError: NSError(domain: "TripPocketShare", code: 0))
    }
}
```

- [ ] **Step 3: Delete `SaveButtonView.swift`**

```sh
git rm native/ShareExtension/SaveButtonView.swift
```

- [ ] **Step 4: Commit all three changes together**

```sh
git add native/ShareExtension/PendingImportWriter.swift native/ShareExtension/ShareViewController.swift
git commit -m "feat(share): trip picker switchover

PendingImportWriter.write now takes suggestedTripId (binds NULL when
nil); ShareViewController hosts TripPickerView and forwards the
chosen trip id; SaveButtonView is removed. Bundled in one commit so
every commit compiles — the writer signature change would otherwise
break the call site mid-sequence."
```

---

## Task 5: Update the Expo config plugin source list

**Why:** `plugins/with-share-extension.js` hard-codes the file list it adds to the share-extension target's `PBXSourcesBuildPhase`. The current list still names `SaveButtonView.swift` (deleted) and omits the two new files. Without this fix, the next `expo prebuild` / EAS build either fails (file not found) or silently omits `TripReader` / `TripPickerView` from the target.

**Files:**
- Modify: `plugins/with-share-extension.js` (lines 30–39)

- [ ] **Step 1: Update the source list**

Replace the `project.addBuildPhase([...], 'PBXSourcesBuildPhase', 'Sources', target.uuid)` call with this version. Only the array contents change.

```javascript
project.addBuildPhase(
  [
    `${TARGET_NAME}/ShareViewController.swift`,
    `${TARGET_NAME}/TripPickerView.swift`,
    `${TARGET_NAME}/TripReader.swift`,
    `${TARGET_NAME}/PendingImportWriter.swift`,
  ],
  'PBXSourcesBuildPhase',
  'Sources',
  target.uuid,
);
```

- [ ] **Step 2: Verify the plugin still loads cleanly**

Run: `node -e "require('./plugins/with-share-extension.js')"`

Expected: command exits 0 with no output.

- [ ] **Step 3: Commit**

```sh
git add plugins/with-share-extension.js
git commit -m "build(ios): register TripPicker + TripReader, drop SaveButton

Updates the share-extension config plugin's PBXSourcesBuildPhase to
match the renamed file set. Without this, prebuild keeps compiling
the deleted SaveButtonView.swift and omits the two new files."
```

---

## Task 6: Build and on-device smoke test

**Files:** none (verification only).

The extension cannot programmatically open the host app, so each smoke step ends with the user manually opening Trip Pocket — that foreground triggers `ingestPendingImports`, which drains the pending row.

- [ ] **Step 1: Regenerate iOS project from the config plugin**

Run: `npx expo prebuild --platform ios --clean`

Expected: completes without errors. The `ios/TripPocketShare/` directory should now contain `ShareViewController.swift`, `TripPickerView.swift`, `TripReader.swift`, `PendingImportWriter.swift`, `Info.plist`, and `TripPocketShare.entitlements` — and **not** `SaveButtonView.swift`.

Verify: `ls ios/TripPocketShare/`

- [ ] **Step 2: EAS dev build**

Run: `eas build --profile development --platform ios`

Expected: build succeeds. Budget one round-trip: if the build fails on the share-extension target compile step, inspect the EAS build log, fix the underlying Swift / plugin issue, and rebuild.

- [ ] **Step 3: Install the dev build on a real iPhone and run smoke tests**

Install the resulting `.ipa` (or via the Expo dev client URL). Then run all six tests from the spec verification plan:

1. **Fresh install** — delete the app first, reinstall from this build, do not create any trips. Open Photos → share a screenshot to Trip Pocket → picker shows the "Save to" sheet with an "Inbox" row only (no "Trips" section). Tap Inbox → extension dismisses. Open Trip Pocket → screenshot is in Inbox.
2. **With trips** — in the app, create three trips ("Japan", "Italy", "Vietnam"). Share a screenshot → picker shows Inbox row + a "Trips" section with the three trips alphabetically. Tap "Italy" → extension dismisses. Open Trip Pocket → screenshot is on the Italy trip.
3. **Inbox path** — share another screenshot, tap "Inbox" in the picker → screenshot lands in Inbox.
4. **Cancel path** — share another screenshot, tap "Cancel" → extension dismisses. Open Trip Pocket → no new screenshot anywhere; nothing in Inbox.
5. **Repeatability** — share three different screenshots in a row, all to "Japan". Open Trip Pocket → all three on Japan; no flakiness.

- [ ] **Step 4: Manual stale-trip sanity check (optional, supplements the unit test)**

The unit test from Task 1 covers this case fully; this step is a belt-and-suspenders manual check.

1. Create a trip "Throwaway" in the app.
2. Force-quit the app.
3. Share a screenshot → tap "Throwaway" in the picker. Don't open the app yet.
4. Open the app, immediately delete "Throwaway" (via trip edit modal). Then close the app *without* triggering ingestion of pending imports — easiest reliable way: relaunch the app cold and watch the screenshot appear in Inbox (because ingestion runs on the app's first foreground after the share).

Note: timing this manually is fiddly because foreground triggers ingestion automatically. If reproducing the race manually is difficult, rely on the unit test — that's why it exists. Skip this step rather than spending more than ~10 minutes wrestling with timing.

- [ ] **Step 5: No commit needed for verification**

Smoke testing produces no code changes. If any test reveals a bug, fix it in a new task and re-run smoke tests.

---

## Definition of done

- All Jest tests pass: `npx jest`.
- `npx expo prebuild --platform ios --clean` succeeds.
- `eas build --profile development --platform ios` succeeds.
- Smoke tests 1–5 in Task 6 all pass on a real iPhone.
- `git log` shows five commits on top of `main` (one per Task 1–5); Task 6 has no commit.
