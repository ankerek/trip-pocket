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
            guard let url = self.materializeImage(data) else {
                // loadItem's completion block runs on an arbitrary queue;
                // cancelRequest must be called on the main thread.
                DispatchQueue.main.async { self.cancel() }
                return
            }
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
