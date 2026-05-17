import Foundation

/// Mirrors `lib/entitlement/shared-user-id.ts`. The main app writes the
/// resolved RevenueCat `appUserID` into the App Group container on every
/// launch (and on `customerInfoUpdated`). The share extension reads it
/// here so the share-time pre-warm POST /extract carries the right
/// `X-RC-User-Id` header.
///
/// Failure modes:
///   - Container missing / file missing / unparseable JSON → returns nil.
///     The share extension MUST handle nil by skipping the prewarm — the
///     app's foreground sweep on next open will drive extraction via the
///     existing path. No user-visible damage.
struct ShareRcUserIdReader {
    private static let appGroupId = "group.com.trippocket.shared"
    private static let fileName = "rc-user-id.json"

    static func read() -> String? {
        guard let groupURL = FileManager.default
            .containerURL(forSecurityApplicationGroupIdentifier: appGroupId) else {
            return nil
        }
        let fileURL = groupURL.appendingPathComponent(fileName)
        guard let data = try? Data(contentsOf: fileURL),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let rcUserId = json["rc_user_id"] as? String,
              !rcUserId.isEmpty else {
            return nil
        }
        return rcUserId
    }
}
