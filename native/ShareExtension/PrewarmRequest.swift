import Foundation

/// Builds the share-time pre-warm POST /extract request and stages its
/// body in the App Group container so a background URLSession can upload
/// it even after the share extension terminates.
///
/// Lifecycle:
///   1. Share extension finishes writing pending_imports.
///   2. Call `Prewarm.fire(for:)` which:
///      a. Reads the RC user id from the App Group (ShareRcUserIdReader).
///      b. Computes contentHash via Canonicalize (matches the TS hash).
///      c. Writes the JSON body to a sibling file in the App Group
///         (FileManager.default.temporaryDirectory inside the extension
///         can be purged on dismiss).
///      d. Schedules a background URLSession uploadTask. iOS owns the
///         upload from here; the extension can die immediately after.
///
/// The AppDelegate registers `handleEventsForBackgroundURLSession` for
/// the matching identifier so iOS can deliver completion to the host app.
enum Prewarm {
    static let sessionIdentifier = "com.trippocket.share.prewarm"
    static let appGroupId = "group.com.trippocket.shared"

    /// Production worker base. Keep in sync with app.config.ts
    /// (`extractionProxyUrl` without the path suffix).
    private static let workerBase = "https://trip-pocket-extract-proxy.ankerek.workers.dev"

    /// Fire-and-forget. Returns true if a background task was scheduled,
    /// false on any pre-flight failure (missing RC id, body write failure,
    /// URL construction failure). False is non-fatal — the app's foreground
    /// sweep on next open will drive extraction via the existing path.
    @discardableResult
    static func fire(for sharedUrl: String) -> Bool {
        guard let rcUserId = ShareRcUserIdReader.read() else {
            return false
        }
        let hash = Canonicalize.contentHash(sharedUrl)
        let payload: [String: Any] = [
            "contentHash": hash,
            "kind": "url",
            "url": sharedUrl,
        ]
        guard let body = try? JSONSerialization.data(withJSONObject: payload),
              let bodyFile = writeBodyToAppGroup(body),
              let endpoint = URL(string: "\(workerBase)/extract") else {
            return false
        }

        var req = URLRequest(url: endpoint)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.setValue(rcUserId, forHTTPHeaderField: "X-RC-User-Id")

        let cfg = URLSessionConfiguration.background(withIdentifier: sessionIdentifier)
        cfg.sharedContainerIdentifier = appGroupId
        // Allow cellular: the share happens on whatever network the user's
        // on; deferring to wifi would defeat the "instant when they open"
        // promise. Worker payload is ~150 bytes; cost is irrelevant.
        cfg.allowsCellularAccess = true
        // No delegate needed: response data is dropped (the app reads state
        // via GET /extract/:hash on next open). The AppDelegate creates a
        // session by identifier WITH a delegate when iOS delivers events
        // back to the host process.
        let session = URLSession(configuration: cfg)
        session.uploadTask(with: req, fromFile: bodyFile).resume()
        // `finishTasksAndInvalidate` schedules invalidation after the
        // upload completes; iOS still persists the task.
        session.finishTasksAndInvalidate()
        return true
    }

    /// Writes the request body to a sibling file in the App Group
    /// container so a background URLSession can read it across extension
    /// termination. The extension's temporaryDirectory may be purged on
    /// dismiss; the App Group container persists for the host app's
    /// lifetime.
    private static func writeBodyToAppGroup(_ data: Data) -> URL? {
        guard let groupURL = FileManager.default
            .containerURL(forSecurityApplicationGroupIdentifier: appGroupId) else {
            return nil
        }
        let dir = groupURL.appendingPathComponent("prewarm-bodies", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let fileURL = dir.appendingPathComponent(UUID().uuidString + ".json")
        do {
            try data.write(to: fileURL)
            return fileURL
        } catch {
            return nil
        }
    }
}
