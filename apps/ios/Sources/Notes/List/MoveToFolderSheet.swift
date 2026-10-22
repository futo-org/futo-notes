import SwiftUI

/// Sheet for moving a note to a destination folder: Root and every existing folder.
struct MoveToFolderSheet: View {
    @EnvironmentObject private var store: NotesStore
    @Environment(\.dismiss) private var dismiss
    @Environment(\.localization) private var localization

    let note: NoteItem
    /// The editor supplies this synchronous handoff so it owns and tracks the
    /// complete asynchronous move. List-row moves use the default store task.
    var onMoveRequested: ((String) -> Void)? = nil

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

    private func move(to folder: String) {
        if let onMoveRequested {
            onMoveRequested(folder)
        } else {
            Task { _ = await store.moveNote(note.id, toFolder: folder) }
        }
        dismiss()
    }
}
