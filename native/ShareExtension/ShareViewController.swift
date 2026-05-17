import UIKit
import SwiftUI
import UniformTypeIdentifiers
import os

private let log = Logger(subsystem: "com.trippocket.share", category: "ShareViewController")

class ShareViewController: UIViewController {
    private let errorState = SaveErrorState()
    private let successState = SaveSuccessState()
    private var lastTripId: String?
    private var lastDestinationName: String = "Inbox"

    override func viewDidLoad() {
        super.viewDidLoad()
        // Entitlement gate — check the App Group status file the main app
        // writes on every entitlement change. If the user's subscription
        // is inactive (or the cached value is too stale to trust), we
        // refuse to write to pending_imports and instead show a screen
        // pointing them back to the main app.
        let verdict = EntitlementReader().read()
        if verdict != .active {
            presentEntitlementBlocked(verdict: verdict)
            return
        }
        let host = UIHostingController(rootView: TripPickerView(
            onSave: { [weak self] tripId, destinationName in
                self?.lastTripId = tripId
                self?.lastDestinationName = destinationName
                self?.handleSave(tripId: tripId, destinationName: destinationName)
            },
            onCancel: { [weak self] in
                self?.cancel()
            },
            errorState: errorState,
            successState: successState,
            onRetry: { [weak self] in
                guard let self else { return }
                self.errorState.set(nil)
                self.handleSave(tripId: self.lastTripId, destinationName: self.lastDestinationName)
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

    private func presentEntitlementBlocked(verdict: EntitlementReader.Verdict) {
        let title: String
        let message: String
        switch verdict {
        case .stale:
            title = "Open Trip Pocket"
            message = "Open Trip Pocket to sync your subscription."
        case .inactive:
            title = "Subscription inactive"
            message = "Open Trip Pocket to resume."
        case .active:
            // Unreachable — viewDidLoad only calls this when verdict != .active.
            title = ""
            message = ""
        }
        let host = UIHostingController(rootView: EntitlementBlockedView(
            title: title,
            message: message,
            onDone: { [weak self] in self?.cancel() }
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

    private func handleSave(tripId: String?, destinationName: String) {
        guard let item = (extensionContext?.inputItems as? [NSExtensionItem])?.first,
              let attachments = item.attachments, !attachments.isEmpty
        else {
            errorState.set(.noContent)
            return
        }

        // Disambiguation: when Instagram's share sheet attaches both a URL and
        // a preview image, prefer the URL — it carries more semantic value
        // than the cover thumbnail alone (the worker fetches caption + cover).
        if let urlProvider = attachments.first(where: { $0.hasItemConformingToTypeIdentifier(UTType.url.identifier) }) {
            handleUrlAttachment(urlProvider, tripId: tripId, destinationName: destinationName)
            return
        }
        if let imageProvider = attachments.first(where: { $0.hasItemConformingToTypeIdentifier(UTType.image.identifier) }) {
            handleImageAttachment(imageProvider, tripId: tripId, destinationName: destinationName)
            return
        }

        errorState.set(.noContent)
    }

    private func handleUrlAttachment(_ provider: NSItemProvider, tripId: String?, destinationName: String) {
        provider.loadItem(forTypeIdentifier: UTType.url.identifier) { [weak self] data, _ in
            guard let self else { return }
            guard let url = self.materializeUrl(data) else {
                self.errorState.set(.noContent)
                return
            }
            guard self.isSupportedHost(url) else {
                self.errorState.set(.unsupportedLink)
                return
            }
            do {
                try PendingImportWriter().write(url: url.absoluteString, suggestedTripId: tripId)
                // Kick off the share-time pre-warm so the worker pipeline
                // (Apify + Gemini) runs while the user is still tapping
                // back from the share sheet. Fire-and-forget; success
                // signal flows through `acknowledgeAndComplete` regardless.
                let scheduled = Prewarm.fire(for: url.absoluteString)
                if !scheduled {
                    log.info("Prewarm skipped (rc id missing or body write failed) — app foreground sweep will drive extraction")
                }
                self.acknowledgeAndComplete(destinationName: destinationName)
            } catch {
                log.error("handleUrlAttachment: write failed: \(String(describing: error), privacy: .public)")
                self.errorState.set(.writeFailed)
            }
        }
    }

    private func handleImageAttachment(_ provider: NSItemProvider, tripId: String?, destinationName: String) {
        provider.loadItem(forTypeIdentifier: UTType.image.identifier) { [weak self] data, _ in
            guard let self else { return }
            guard let url = self.materializeImage(data) else {
                log.error("handleImageAttachment: materializeImage returned nil")
                self.errorState.set(.writeFailed)
                return
            }
            do {
                try PendingImportWriter().write(imageAt: url, suggestedTripId: tripId)
                self.acknowledgeAndComplete(destinationName: destinationName)
            } catch {
                log.error("handleImageAttachment: write failed: \(String(describing: error), privacy: .public)")
                self.errorState.set(.writeFailed)
            }
        }
    }

    // Fires a success haptic, swaps the picker to a "Saved to {dest}" overlay,
    // then dismisses the sheet after a short visible beat (~600ms). This is the
    // only signal the user gets that Trip Pocket received the share before
    // returning to the source app — processing of the pending row happens
    // later, in the main app, on next foreground.
    private func acknowledgeAndComplete(destinationName: String) {
        DispatchQueue.main.async {
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            self.successState.set(destinationName)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
                self.extensionContext?.completeRequest(returningItems: nil)
            }
        }
    }

    private func materializeUrl(_ data: NSSecureCoding?) -> URL? {
        if let url = data as? URL { return url }
        if let s = data as? String { return URL(string: s) }
        return nil
    }

    private func isSupportedHost(_ url: URL) -> Bool {
        guard let rawHost = url.host?.lowercased() else { return false }
        // Strip leading "www." and "m." for matching, mirroring the worker's
        // detectPlatform behaviour so we stay consistent across layers.
        var host = rawHost
        for prefix in ["www.", "m."] {
            if host.hasPrefix(prefix) {
                host = String(host.dropFirst(prefix.count))
                break
            }
        }
        return host == "instagram.com"
            || host == "instagr.am"
            || host == "tiktok.com"
            || host == "vm.tiktok.com"
            || host == "vt.tiktok.com"
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
