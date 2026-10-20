import SwiftUI

/// Alert-look-alike card for creating a folder, hosted in a transparent
/// `fullScreenCover`. Exists because `.alert` snapshots its `message:` closure
/// when presented — the case-insensitive duplicate warning (list.md) must
/// update live while the user types, which only real view content does.
/// Mirrors Android's NewFolderDialog.kt: inline duplicate error, Create
/// disabled on empty/duplicate names.
struct NewFolderDialog: View {
    let title: String
    let confirmLabel: String
    /// Live status line under the title: the create hint or, on a
    /// case-insensitive sibling collision, the duplicate warning.
    let message: String
    /// Whether `message` is the duplicate warning (rendered in danger red).
    let messageIsWarning: Bool
    @Binding var name: String
    let canCreate: Bool
    let onCancel: () -> Void
    let onCreate: () -> Void
    @Environment(\.localization) private var localization

    @FocusState private var nameFocused: Bool

    var body: some View {
        ZStack {
            // The same dim a real alert draws. Taps on it do NOT dismiss —
            // parity with the .alert this replaced. ignoresSafeArea extends it
            // under the keyboard inset while the centered card still respects
            // it, so the card slides up above the keyboard like an alert.
            Color.black.opacity(0.2)
                .ignoresSafeArea()
            VStack(spacing: 0) {
                VStack(spacing: 6) {
                    Text(title)
                        .font(.headline)
                    Text(message)
                        .font(.footnote)
                        .foregroundStyle(messageIsWarning ? Theme.danger : Color.secondary)
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                    TextField(localization.localizedText("folders.nameField"), text: $name)
                        .textFieldStyle(.roundedBorder)
                        .font(.callout)
                        .focused($nameFocused)
                        .submitLabel(.done)
                        .onSubmit { if canCreate { onCreate() } }
                        .padding(.top, 6)
                }
                .padding(.horizontal, 16)
                .padding(.top, 19)
                .padding(.bottom, 16)
                Divider()
                HStack(spacing: 0) {
                    Button(action: onCancel) {
                        Text(localization.localizedText("common.actions.cancel"))
                            .fontWeight(.semibold)
                            .frame(maxWidth: .infinity, minHeight: 44)
                    }
                    Divider()
                        .frame(height: 44)
                    Button(action: onCreate) {
                        Text(confirmLabel)
                            .frame(maxWidth: .infinity, minHeight: 44)
                    }
                    .disabled(!canCreate)
                }
            }
            .frame(width: 270)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14))
            .defaultFocus($nameFocused, true)
            .onAppear {
                // Belt-and-braces with .defaultFocus: initial focus inside a
                // fresh presentation can miss while the view tree settles, and
                // the .alert this replaced always raised the keyboard.
                DispatchQueue.main.async { nameFocused = true }
            }
        }
    }
}
