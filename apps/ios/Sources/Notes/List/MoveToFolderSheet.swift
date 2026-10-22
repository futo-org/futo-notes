import SwiftUI

/// A move sheet's verbs while it is up: `PickFolder {path?}` is a tap on one of its rows (no
/// path, or "", is the Root row) and `DismissDialog` its Cancel. Every row carries its folder
/// (`ListRowID.folder`, "" for Root), so `elements` shows `folder=` and the CLI refuses a row
/// scrolled out of the sheet. `pick` answers whether the move landed.
@MainActor
func moveSheetVerbs(
    offering destinations: [String], of folders: [String],
    pick: @escaping (String) async -> Bool, cancel: @escaping () -> Void
) -> [PuppetVerbs.Verb] {
    [
        PuppetVerbs.Verb("PickFolder", optional: ["path"], controls: ["folders.root"]) {
            arguments in
            let path = (arguments["path"] as? String) ?? ""
            if !path.isEmpty, !destinations.contains(path) {
                throw folders.contains(path)
                    ? PuppetVerbRefusal(409, "`\(path)` is not a destination this sheet offers")
                    : PuppetVerbRefusal(400, "no such folder: \(path)")
            }
            guard await pick(path) else { throw PuppetVerbRefusal(409, "the move was refused") }
            return ["path": path]
        },
        PuppetVerbs.Verb("DismissDialog", controls: ["common.actions.cancel"]) { cancel() },
    ]
}

/// Sheet for moving a note to a destination folder: Root and every existing folder.
struct MoveToFolderSheet: View {
    @EnvironmentObject private var store: NotesStore
    @Environment(\.dismiss) private var dismiss
    @Environment(\.localization) private var localization

    let note: NoteItem
    /// The editor supplies this synchronous handoff so it owns and tracks the
    /// complete asynchronous move, whose task answers whether it landed.
    /// List-row moves use the default store task.
    var onMoveRequested: ((String) -> Task<Bool, Never>?)? = nil

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Button {
                        move(to: "")
                    } label: {
                        rowLabel(
                            text: localization.localizedText("folders.root"),
                            system: "house.fill",
                            isCurrent: note.folder.isEmpty)
                    }
                    .accessibilityIdentifier(ListRowID.folder(""))
                }
                if !store.folders.isEmpty {
                    Section(localization.localizedText("folders.heading")) {
                        ForEach(store.folders, id: \.self) { path in
                            Button {
                                move(to: path)
                            } label: {
                                rowLabel(
                                    text: path, system: "folder.fill",
                                    isCurrent: note.folder == path)
                            }
                            .accessibilityIdentifier(ListRowID.folder(path))
                        }
                    }
                }
            }
            .navigationTitle(
                localization.localizedText(
                    "notes.moveNamedHeading",
                    arguments: ["noteTitle": note.title]
                )
            )
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button(localization.localizedText("common.actions.cancel")) { dismiss() }
                        .tint(Theme.primary)
                }
            }
        }
        .puppetVerbs(modal: true) {
            moveSheetVerbs(
                offering: store.folders, of: store.folders,
                pick: { folder in await move(to: folder)?.value ?? false },
                cancel: { dismiss() })
        }
    }

    @ViewBuilder
    private func rowLabel(text: String, system: String, isCurrent: Bool) -> some View {
        HStack {
            Label {
                Text(text).foregroundStyle(.primary)
            } icon: {
                Image(systemName: system).foregroundStyle(Theme.primary)
            }
            Spacer()
            if isCurrent {
                Image(systemName: "checkmark")
                    .foregroundStyle(Theme.primary)
            }
        }
    }

    /// Starts the move and closes the sheet; the task answers whether the move landed.
    @discardableResult
    private func move(to folder: String) -> Task<Bool, Never>? {
        let moving: Task<Bool, Never>?
        if let onMoveRequested {
            moving = onMoveRequested(folder)
        } else {
            moving = Task { () async -> Bool in
                if case .committed = await store.moveNote(note.id, toFolder: folder) {
                    return true
                }
                return false
            }
        }
        dismiss()
        return moving
    }
}
