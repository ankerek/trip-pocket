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
        // Track the last status so SQLITE_BUSY / SQLITE_ERROR mid-iteration
        // returns Inbox-only (per the spec's failure-mode contract) instead
        // of a partially-populated list.
        var lastStatus: Int32 = SQLITE_OK
        while true {
            lastStatus = sqlite3_step(stmt)
            if lastStatus != SQLITE_ROW { break }
            guard let idCStr = sqlite3_column_text(stmt, 0),
                  let nameCStr = sqlite3_column_text(stmt, 1) else { continue }
            let id = String(cString: idCStr)
            let name = String(cString: nameCStr)
            results.append(Trip(id: id, name: name))
        }
        guard lastStatus == SQLITE_DONE else {
            return []
        }
        return results
    }
}
