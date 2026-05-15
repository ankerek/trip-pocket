import Foundation

/// Mirrors `lib/entitlement/shared-storage.ts`. The main app writes a JSON
/// blob into the App Group container on every entitlement-status change; we
/// read it here to decide whether to accept this share or refuse with a
/// "Open Trip Pocket to resume" view. Fail-open behaviour: a missing or
/// unparseable file is treated as `active`, and a 401 from the main-app's
/// pipeline will pause the row downstream so the user still sees a paused-
/// chip in the inbox.
struct EntitlementReader {
    private let appGroupId = "group.com.trippocket.shared"
    private let fileName = "entitlement-status.json"

    /// Max age before a fresh-looking `active` value is no longer trusted.
    /// Mirrors the spec's stale-value policy — a user who hasn't opened the
    /// main app in a week may have changed subscription state without us
    /// knowing.
    private let staleThreshold: TimeInterval = 60 * 60 * 24 * 7

    enum Verdict {
        /// Subscription is active and fresh. Proceed with the share.
        case active
        /// Subscription is inactive and fresh. Show the resume view.
        case inactive
        /// Status file is older than `staleThreshold`. Show the "open the app"
        /// view so the main process can re-sync.
        case stale
    }

    func read(now: Date = Date()) -> Verdict {
        guard let groupURL = FileManager.default
            .containerURL(forSecurityApplicationGroupIdentifier: appGroupId) else {
            // App Group misconfigured. Fail-open: 401 fallback in the main
            // app's pipeline will pause downstream.
            return .active
        }
        let fileURL = groupURL.appendingPathComponent(fileName)
        guard let data = try? Data(contentsOf: fileURL) else {
            // File missing — first-ever launch of main app hasn't written
            // it yet, or write failed. Fail-open.
            return .active
        }
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let status = json["status"] as? String,
              let updatedAtRaw = json["updated_at"] as? String else {
            return .active
        }
        guard let updatedAt = Self.iso8601.date(from: updatedAtRaw) else {
            return .active
        }
        if now.timeIntervalSince(updatedAt) > staleThreshold {
            return .stale
        }
        return status == "inactive" ? .inactive : .active
    }

    private static let iso8601: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
}
