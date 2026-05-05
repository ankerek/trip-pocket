import Foundation
import SQLite3

enum PendingImportError: Error {
    case noAppGroup
    case copyFailed
    case dbFailed
}

struct PendingImportWriter {
    let appGroupId = "group.com.trippocket.shared"

    func write(imageAt sourceURL: URL) throws {
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
            VALUES (?, ?, NULL, ?);
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
        // Store the full file:// URI so the JS side (expo-file-system class API)
        // can construct a File directly from app_group_path without inferring scheme.
        sqlite3_bind_text(stmt, 1, id, -1, SQLITE_TRANSIENT)
        sqlite3_bind_text(stmt, 2, destURL.absoluteString, -1, SQLITE_TRANSIENT)
        sqlite3_bind_text(stmt, 3, createdAt, -1, SQLITE_TRANSIENT)

        guard sqlite3_step(stmt) == SQLITE_DONE else {
            throw PendingImportError.dbFailed
        }
    }
}
