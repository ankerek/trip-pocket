import Foundation

/// Strong-held URLSession + completion handler for the share-extension
/// prewarm session (identifier "com.trippocket.share.prewarm"). Lifetime:
/// from `handleEventsForBackgroundURLSession` until iOS calls
/// `urlSessionDidFinishEvents(forBackgroundURLSession:)`.
///
/// Why this exists: the share extension creates a background URLSession,
/// fires an upload, and dies. iOS later relaunches the host app to
/// deliver the completion events; the host MUST recreate the session by
/// identifier WITH a delegate, retain it until events finish, then call
/// the system-provided completion handler. Dropping any of those three
/// steps causes iOS to throttle background event delivery to this app.
///
/// The session does no per-request work — the response is dropped (the
/// app reads orchestrator state via GET /extract/:hash on next open).
/// We only need the delegate to receive `didFinishEvents` so we can
/// notify the system.
final class PrewarmSessionHolder: NSObject, URLSessionDelegate {
    static let shared = PrewarmSessionHolder()

    private var session: URLSession?
    private var completionHandler: (() -> Void)?

    func attach(identifier: String, completion: @escaping () -> Void) {
        self.completionHandler = completion
        let cfg = URLSessionConfiguration.background(withIdentifier: identifier)
        cfg.sharedContainerIdentifier = "group.com.trippocket.shared"
        self.session = URLSession(
            configuration: cfg,
            delegate: self,
            delegateQueue: .main,
        )
    }

    func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        // iOS delivered all pending events for the session. Invoke the
        // system-provided handler so background event delivery to this
        // app stays healthy, and drop our references so subsequent
        // sessions don't leak.
        DispatchQueue.main.async { [weak self] in
            let handler = self?.completionHandler
            self?.completionHandler = nil
            self?.session = nil
            handler?()
        }
    }
}
