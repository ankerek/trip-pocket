import SwiftUI

struct TripPickerView: View {
    let onSave: (String?) -> Void
    let onCancel: () -> Void

    @State private var trips: [TripReader.Trip] = []
    @State private var loaded = false

    var body: some View {
        NavigationView {
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
            .navigationTitle("Save to")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: onCancel)
                }
            }
        }
        // The share-extension target supports iPhone + iPad (TARGETED_DEVICE_FAMILY="1,2"),
        // and NavigationView defaults to a split style on iPad — force single-column.
        // (NavigationStack is iOS 16+; deployment target is 15.1, so NavigationView stays.)
        .navigationViewStyle(.stack)
        .onAppear {
            // Load once; re-appear (e.g. from background) shouldn't re-query
            // and risk flicker. The extension is short-lived anyway.
            guard !loaded else { return }
            trips = TripReader().listTrips()
            loaded = true
        }
    }
}
