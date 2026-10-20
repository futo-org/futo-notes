import SwiftUI

/// Sheet for moving a note to a destination folder. Lists Root, every existing
/// folder, and a "New Folder…" option that creates a folder (under the note's
/// current folder) and moves the note into it.
struct MoveToFolderSheet: View {
    @EnvironmentObject private var store: NotesStore
    @Environment(\.dismiss) private var dismiss
    @Environment(\.localization) private var localization

    let note: NoteItem
    /// Folder currently being browsed — used as the parent for a brand-new
    /// folder created from this sheet.
    let currentFolder: String
    /// The editor supplies this synchronous handoff so it owns and tracks the
    /// complete asynchronous move. List-row moves use the default store task.
    var onMoveRequested: ((String) -> Void)? = nil

    @State private var showingNewFolder = false
    @State private var newFolderName = ""

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
                Section {
                    Button {
                        newFolderName = ""
                        showingNewFolder = true
                    } label: {
                        Label(
                            localization.localizedText("folders.newFolderEllipsis"),
                            systemImage: "folder.badge.plus"
                        )
                        .foregroundStyle(Theme.primary)
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
            .alert(
                localization.localizedText("folders.newFolderTitleCase"),
                isPresented: $showingNewFolder
            ) {
                TextField(
                    localization.localizedText("folders.nameField"),
                    text: $newFolderName
                )
                Button(localization.localizedText("common.actions.cancel"), role: .cancel) {}
                Button(localization.localizedText("notes.move.createAndMove")) { createAndMove() }
            } message: {
                Text(
                    currentFolder.isEmpty
                        ? localization.localizedText("notes.move.createFolderPrompt")
                        : localization.localizedText(
                            "notes.move.createFolderInPrompt",
                            arguments: ["folderName": currentFolder]
                        )
                )
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
        performMove(to: folder)
        dismiss()
    }

    private func performMove(to folder: String) {
        if let onMoveRequested {
            onMoveRequested(folder)
        } else {
            Task { _ = await store.moveNote(note.id, toFolder: folder) }
        }
    }

    private func createAndMove() {
        let name = newFolderName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return }
        let dest = currentFolder.isEmpty ? name : currentFolder + "/" + name
        performMove(to: dest)
        dismiss()
    }
}
