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

        // Any failure past this point must remove the just-copied file. The user
        // can tap Retry from the share-sheet UI; without cleanup, every retry
        // on a persistent DB-failure would orphan another inbox image.
        do {
            try insertPendingRow(
                groupURL: groupURL,
                kind: "image",
                appGroupPath: destURL.absoluteString,
                url: nil,
                suggestedTripId: suggestedTripId
            )
        } catch {
            try? FileManager.default.removeItem(at: destURL)
            throw error
        }
    }

    /// Writes a pending row for a shared URL (Instagram or TikTok post). No
    /// file is materialised — the URL itself is the payload.
    func write(url shareUrl: String, suggestedTripId: String?) throws {
        guard let groupURL = FileManager.default
            .containerURL(forSecurityApplicationGroupIdentifier: appGroupId) else {
            throw PendingImportError.noAppGroup
        }

        try insertPendingRow(
            groupURL: groupURL,
            kind: "url",
            appGroupPath: nil,
            url: shareUrl,
            suggestedTripId: suggestedTripId
        )
    }

    private func insertPendingRow(
        groupURL: URL,
        kind: String,
        appGroupPath: String?,
        url: String?,
        suggestedTripId: String?
    ) throws {
        let dbURL = groupURL.appendingPathComponent("trip-pocket.db")
        var db: OpaquePointer?
        guard sqlite3_open(dbURL.path, &db) == SQLITE_OK else {
            throw PendingImportError.dbFailed
        }
        defer { sqlite3_close(db) }

        // Set WAL so the main app and extension can read/write concurrently. WAL is
        // a persistent per-database property, so this only matters when the extension
        // is the first process to ever open the file.
        sqlite3_exec(db, "PRAGMA journal_mode = WAL;", nil, nil, nil)

        // The main app creates the table at first launch; the extension creates it
        // defensively in case it runs first. CREATE IF NOT EXISTS matches the
        // migration's idempotent shape so the main app's first migration won't fail.
        let create = """
            CREATE TABLE IF NOT EXISTS pending_imports (
                id TEXT PRIMARY KEY NOT NULL,
                kind TEXT NOT NULL DEFAULT 'image'
                    CHECK (kind IN ('image','url')),
                app_group_path TEXT,
                url TEXT,
                suggested_trip_id TEXT,
                created_at TEXT NOT NULL
            );
        """
        if sqlite3_exec(db, create, nil, nil, nil) != SQLITE_OK {
            throw PendingImportError.dbFailed
        }

        // Backfill columns on an existing table that was created by an older
        // build of the extension (or the main app). ALTER TABLE … ADD COLUMN
        // returns an error on duplicate-column; we swallow it silently — the
        // only way it should fail is if the column already exists.
        sqlite3_exec(
            db,
            "ALTER TABLE pending_imports ADD COLUMN kind TEXT NOT NULL DEFAULT 'image';",
            nil, nil, nil
        )
        sqlite3_exec(db, "ALTER TABLE pending_imports ADD COLUMN url TEXT;", nil, nil, nil)

        let insert = """
            INSERT INTO pending_imports (id, kind, app_group_path, url, suggested_trip_id, created_at)
            VALUES (?, ?, ?, ?, ?, ?);
        """
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, insert, -1, &stmt, nil) == SQLITE_OK else {
            throw PendingImportError.dbFailed
        }
        defer { sqlite3_finalize(stmt) }

        let id = UUID().uuidString
        let createdAt = ISO8601DateFormatter().string(from: Date())
        // SQLITE_TRANSIENT — force SQLite to copy the C string immediately, since the
        // bridged buffer from Swift String only lives for the duration of this call.
        let SQLITE_TRANSIENT = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

        sqlite3_bind_text(stmt, 1, id, -1, SQLITE_TRANSIENT)
        sqlite3_bind_text(stmt, 2, kind, -1, SQLITE_TRANSIENT)
        if let path = appGroupPath {
            // Store the full file:// URI so the JS side (expo-file-system class API)
            // can construct a File directly from app_group_path without inferring scheme.
            sqlite3_bind_text(stmt, 3, path, -1, SQLITE_TRANSIENT)
        } else {
            sqlite3_bind_null(stmt, 3)
        }
        if let urlString = url {
            sqlite3_bind_text(stmt, 4, urlString, -1, SQLITE_TRANSIENT)
        } else {
            sqlite3_bind_null(stmt, 4)
        }
        if let tripId = suggestedTripId {
            sqlite3_bind_text(stmt, 5, tripId, -1, SQLITE_TRANSIENT)
        } else {
            sqlite3_bind_null(stmt, 5)
        }
        sqlite3_bind_text(stmt, 6, createdAt, -1, SQLITE_TRANSIENT)

        guard sqlite3_step(stmt) == SQLITE_DONE else {
            throw PendingImportError.dbFailed
        }
    }
}
