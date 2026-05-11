import SwiftUI
import Combine

enum ShareSaveError {
    case noImage
    case writeFailed
}

// Drives the picker's error overlay. Owned by ShareViewController so it can
// publish failures back into the SwiftUI view from background callbacks.
final class SaveErrorState: ObservableObject {
    @Published var value: ShareSaveError?

    func set(_ next: ShareSaveError?) {
        DispatchQueue.main.async { self.value = next }
    }
}

struct TripPickerView: View {
    let onSave: (String?) -> Void
    let onCancel: () -> Void
    @ObservedObject var errorState: SaveErrorState
    let onRetry: () -> Void

    @State private var trips: [TripReader.Trip] = []
    @State private var loaded = false

    var body: some View {
        NavigationView {
            Group {
                if let error = errorState.value {
                    errorView(for: error)
                } else {
                    pickerList
                }
            }
            .navigationTitle(errorState.value == nil ? "Save to" : "Couldn't save")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: onCancel)
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

    private var pickerList: some View {
        List {
            Section {
                Button(action: { onSave(nil) }) {
                    Text("Inbox")
                        .foregroundColor(.primary)
                }
            }
            if !trips.isEmpty {
                Section("Trips") {
                    ForEach(trips, id: \.id) { trip in
                        Button(action: { onSave(trip.id) }) {
                            Text(trip.name)
                                .foregroundColor(.primary)
                        }
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
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
        case .noImage: return "No image to save"
        case .writeFailed: return "Couldn't save"
        }
    }

    private func body(for error: ShareSaveError) -> String {
        switch error {
        case .noImage:
            return "This share didn't include an image we can read."
        case .writeFailed:
            return "Trip Pocket couldn't save the screenshot. Try again, or open Trip Pocket if the problem keeps happening."
        }
    }
}
