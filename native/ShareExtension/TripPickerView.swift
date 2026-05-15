import SwiftUI
import Combine

enum ShareSaveError {
    case noContent       // share intent had neither an image nor a URL we can read
    case unsupportedLink // shared URL is from a platform Trip Pocket doesn't support yet
    case writeFailed     // I/O or DB failure while persisting the pending row
}

// Drives the picker's error overlay. Owned by ShareViewController so it can
// publish failures back into the SwiftUI view from background callbacks.
final class SaveErrorState: ObservableObject {
    @Published var value: ShareSaveError?

    func set(_ next: ShareSaveError?) {
        DispatchQueue.main.async { self.value = next }
    }
}

// Drives the post-save acknowledgment overlay. Set to the destination name
// ("Inbox" or trip name) when the pending row is written; the view shows a
// checkmark for ~600ms before the controller dismisses the sheet, so the user
// gets a visible+haptic signal that the share landed before returning to
// Instagram/TikTok.
final class SaveSuccessState: ObservableObject {
    @Published var destinationName: String?

    func set(_ name: String?) {
        DispatchQueue.main.async { self.destinationName = name }
    }
}

// Shown by ShareViewController when the App Group's `entitlement-status.json`
// reports an inactive or stale subscription. The share is refused at the
// extension boundary — nothing is written to pending_imports — so the main
// app's pipeline never sees a row it would just have to pause.
struct EntitlementBlockedView: View {
    let title: String
    let body: String
    let onDone: () -> Void

    var bodyView: some View {
        NavigationView {
            VStack(spacing: 16) {
                Spacer()
                Image(systemName: "lock.circle.fill")
                    .resizable()
                    .frame(width: 56, height: 56)
                    .foregroundColor(.orange)
                Text(title)
                    .font(.headline)
                    .multilineTextAlignment(.center)
                Text(body)
                    .font(.subheadline)
                    .foregroundColor(.secondary)
                    .multilineTextAlignment(.center)
                Spacer()
            }
            .padding()
            .navigationTitle("Trip Pocket")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done", action: onDone)
                }
            }
        }
        .navigationViewStyle(.stack)
    }

    var body: some View { bodyView }
}

struct TripPickerView: View {
    let onSave: (String?, String) -> Void
    let onCancel: () -> Void
    @ObservedObject var errorState: SaveErrorState
    @ObservedObject var successState: SaveSuccessState
    let onRetry: () -> Void

    @State private var trips: [TripReader.Trip] = []
    @State private var loaded = false

    var body: some View {
        NavigationView {
            Group {
                if let error = errorState.value {
                    errorView(for: error)
                } else if let dest = successState.destinationName {
                    successView(destinationName: dest)
                } else {
                    pickerList
                }
            }
            .navigationTitle(navTitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                // Always render the ToolbarItem — `if` inside .toolbar is
                // iOS 16+ only, and the deployment target is 15.1. Hide and
                // disable the button during the success-overlay window so it
                // can't race with the auto-dismiss timer.
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: onCancel)
                        .opacity(successState.destinationName == nil ? 1 : 0)
                        .disabled(successState.destinationName != nil)
                }
            }
        }
        .navigationViewStyle(.stack)
        .onAppear {
            guard !loaded else { return }
            trips = TripReader().listTrips()
            loaded = true
        }
    }

    private var navTitle: String {
        if errorState.value != nil { return "Couldn't save" }
        if successState.destinationName != nil { return "Saved" }
        return "Save to"
    }

    private var pickerList: some View {
        List {
            Section {
                Button(action: { onSave(nil, "Inbox") }) {
                    Text("Inbox")
                        .foregroundColor(.primary)
                }
            }
            if !trips.isEmpty {
                Section("Trips") {
                    ForEach(trips, id: \.id) { trip in
                        Button(action: { onSave(trip.id, trip.name) }) {
                            Text(trip.name)
                                .foregroundColor(.primary)
                        }
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
    }

    private func successView(destinationName: String) -> some View {
        VStack(spacing: 12) {
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 48, weight: .regular))
                .foregroundColor(.green)
            Text("Saved to \(destinationName)")
                .font(.headline)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func errorView(for error: ShareSaveError) -> some View {
        VStack(spacing: 16) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 36, weight: .regular))
                .foregroundColor(.orange)
            Text(headline(for: error))
                .font(.headline)
                .multilineTextAlignment(.center)
            Text(body(for: error))
                .font(.subheadline)
                .foregroundColor(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 24)
            if error == .writeFailed {
                Button(action: onRetry) {
                    Text("Try again")
                        .font(.headline)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 12)
                }
                .buttonStyle(.borderedProminent)
                .padding(.horizontal, 24)
            }
        }
        .padding(.vertical, 32)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
    }

    private func headline(for error: ShareSaveError) -> String {
        switch error {
        case .noContent: return "Nothing to save"
        case .unsupportedLink: return "Link not supported yet"
        case .writeFailed: return "Couldn't save"
        }
    }

    private func body(for error: ShareSaveError) -> String {
        switch error {
        case .noContent:
            return "This share didn't include an image or a supported link."
        case .unsupportedLink:
            return "Trip Pocket can save Instagram and TikTok posts so far. Share a post from either app to try again."
        case .writeFailed:
            return "Trip Pocket couldn't save this share. Try again, or open Trip Pocket if the problem keeps happening."
        }
    }
}
