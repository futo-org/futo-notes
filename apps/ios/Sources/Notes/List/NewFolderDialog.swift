import SwiftUI

/// Alert-look-alike card for creating a folder, hosted in a transparent
/// `fullScreenCover`. Exists because `.alert` snapshots its `message:` closure
/// when presented — the case-insensitive duplicate warning (list.md) must
/// update live while the user types, which only real view content does.
/// Mirrors Android's NewFolderDialog.kt: inline duplicate error, Create
/// disabled on empty/duplicate names. `renaming` makes it the rename dialog,
/// whose verbs are SetNewName and SubmitRename.
struct NewFolderDialog: View {
    let renaming: Bool
    /// Live status line under the title: the create hint or, on a
    /// case-insensitive sibling collision, the duplicate warning.
    let message: String
    /// Whether `message` is the duplicate warning (rendered in danger red).
    let messageIsWarning: Bool
    @Binding var name: String
    let canCreate: Bool
    let onCancel: () -> Void
    /// Whether the store took the name; `SubmitNewFolder` and `SubmitRename` answer with it.
    let onCreate: () async -> Bool
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
                    Text(
                        localization.localizedText(
                            renaming ? "folders.renameHeading" : "folders.newFolderTitleCase")
                    )
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
                        .onSubmit { if canCreate { Task { _ = await onCreate() } } }
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
                    Button {
                        Task { _ = await onCreate() }
                    } label: {
                        Text(
                            localization.localizedText(
                                renaming ? "common.actions.rename" : "common.actions.create")
                        )
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
        // While it is up it is all a person can reach: the field, the confirm button and
        // Cancel. The name is set as typing sets it, so the warning and the confirm button
        // follow it; a disabled confirm is refused with what the dialog shows under its title.
        .puppetVerbs(modal: true) {
            let setName: ([String: Any]) async throws -> [String: Any] = { arguments in
                name = (arguments["name"] as? String) ?? ""
                return ["name": name]
            }
            let submit: ([String: Any]) async throws -> [String: Any] = { _ in
                guard canCreate else {
                    let action = renaming ? "Rename" : "Create"
                    throw PuppetVerbRefusal(
                        409,
                        messageIsWarning
                            ? message
                            : "the name is \(renaming ? "empty or unchanged" : "empty"), "
                                + "so \(action) is disabled")
                }
                guard await onCreate() else {
                    throw PuppetVerbRefusal(
                        409, "the store refused the \(renaming ? "rename" : "new folder")")
                }
                return [:]
            }
            return [
                renaming
                    ? PuppetVerbs.Verb(
                        "SetNewName", required: ["name"], controls: ["folders.nameField"],
                        run: setName)
                    : PuppetVerbs.Verb(
                        "SetNewFolderName", required: ["name"], controls: ["folders.nameField"],
                        run: setName),
                renaming
                    ? PuppetVerbs.Verb(
                        "SubmitRename", controls: ["common.actions.rename"], run: submit)
                    : PuppetVerbs.Verb(
                        "SubmitNewFolder", controls: ["common.actions.create"], run: submit),
                PuppetVerbs.Verb("DismissDialog", controls: ["common.actions.cancel"]) {
                    onCancel()
                },
            ]
        }
    }
}
