import UIKit
import SwiftUI
import UniformTypeIdentifiers
import os

private let log = Logger(subsystem: "com.trippocket.share", category: "ShareViewController")

class ShareViewController: UIViewController {
    private let errorState = SaveErrorState()
    private var lastTripId: String?

    override func viewDidLoad() {
        super.viewDidLoad()
        let host = UIHostingController(rootView: TripPickerView(
            onSave: { [weak self] tripId in
                self?.lastTripId = tripId
                self?.handleSave(tripId: tripId)
            },
            onCancel: { [weak self] in
                self?.cancel()
            },
            errorState: errorState,
            onRetry: { [weak self] in
                guard let self else { return }
                self.errorState.set(nil)
                self.handleSave(tripId: self.lastTripId)
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
              let attachments = item.attachments, !attachments.isEmpty
        else {
            errorState.set(.noContent)
            return
        }

        // Disambiguation: when Instagram's share sheet attaches both a URL and
        // a preview image, prefer the URL — it carries more semantic value
        // than the cover thumbnail alone (the worker fetches caption + cover).
        if let urlProvider = attachments.first(where: { $0.hasItemConformingToTypeIdentifier(UTType.url.identifier) }) {
            handleUrlAttachment(urlProvider, tripId: tripId)
            return
        }
        if let imageProvider = attachments.first(where: { $0.hasItemConformingToTypeIdentifier(UTType.image.identifier) }) {
            handleImageAttachment(imageProvider, tripId: tripId)
            return
        }

        errorState.set(.noContent)
    }

    private func handleUrlAttachment(_ provider: NSItemProvider, tripId: String?) {
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
                DispatchQueue.main.async {
                    self.extensionContext?.completeRequest(returningItems: nil)
                }
            } catch {
                log.error("handleUrlAttachment: write failed: \(String(describing: error), privacy: .public)")
                self.errorState.set(.writeFailed)
            }
        }
    }

    private func handleImageAttachment(_ provider: NSItemProvider, tripId: String?) {
        provider.loadItem(forTypeIdentifier: UTType.image.identifier) { [weak self] data, _ in
            guard let self else { return }
            guard let url = self.materializeImage(data) else {
                log.error("handleImageAttachment: materializeImage returned nil")
                self.errorState.set(.writeFailed)
                return
            }
            do {
                try PendingImportWriter().write(imageAt: url, suggestedTripId: tripId)
                DispatchQueue.main.async {
                    self.extensionContext?.completeRequest(returningItems: nil)
                }
            } catch {
                log.error("handleImageAttachment: write failed: \(String(describing: error), privacy: .public)")
                self.errorState.set(.writeFailed)
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
