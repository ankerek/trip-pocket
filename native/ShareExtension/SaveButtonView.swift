import SwiftUI

struct SaveButtonView: View {
    let onSave: () -> Void
    let onCancel: () -> Void

    var body: some View {
        VStack(spacing: 24) {
            Spacer()
            Text("Save to Trip Pocket")
                .font(.title2).bold()
            Button(action: onSave) {
                Text("Save to Inbox")
                    .frame(maxWidth: .infinity)
                    .padding()
                    .background(Color.accentColor)
                    .foregroundColor(.white)
                    .cornerRadius(12)
            }
            Button("Cancel", action: onCancel)
                .padding(.bottom, 8)
        }
        .padding()
    }
}
