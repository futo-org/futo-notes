import SwiftUI

extension FolderContentsView {
    func createNote() {
        Task {
            // Quick capture: name it "Untitled" and drop straight into the body.
            // No title prompt — the editor opens body-focused (.newNote →
            // autoFocus), the note is renamed later via the ⋯ menu, and an
            // untouched note is discarded on back-out (NoteEditorView.onDisappear).
            if let id = await store.createNote(title: "Untitled", folder: folder) {
                navPath.append(.newNote(id))
            }
        }
    }

    func createFolder() {
        // Hard guard behind the disabled Create button: never call through to
        // the idempotent Rust create_dir_all on an empty name or a
        // case-insensitive sibling collision — that would silently MERGE into
        // the existing folder. [list.md]
        guard canCreateNewFolder else { return }
        let clean = newFolderClean
        store.createFolder(folder.isEmpty ? clean : folder + "/" + clean)
    }

    func renameFolder() {
        guard let target = folderRenameTarget else { return }
        // Same hard guard as createFolder: the disabled Rename button must not
        // be the only thing standing between a rejected name and the engine.
        guard canRenameFolder else { return }
        let destination = renamedFolderPath
        Task {
            if await store.renameFolder(from: target, to: destination) != nil {
                store.showTransient(LocalizedMessage("folders.renamed"))
            } else {
                store.showTransient(LocalizedMessage("folders.errors.renameFailed"))
            }
            setFolderRenameTarget(nil)
        }
    }

    /// Show/hide the New Folder dialog with presentation animations disabled,
    /// so its transparent fullScreenCover pops in place like the .alert it
    /// replaced instead of playing the cover's default slide-up.
    func setNewFolderDialog(visible: Bool) {
        presentWithoutAnimation { showingNewFolder = visible }
    }

    /// Sets/clears the note delete-confirmation target without the implicit
    /// slide-up transition (see `presentWithoutAnimation`).
    func setDeleteTarget(_ note: NoteItem?) {
        presentWithoutAnimation { deleteTarget = note }
    }

    /// Sets/clears the folder delete-confirmation target without the implicit
    /// slide-up transition (see `presentWithoutAnimation`).
    func setFolderDeleteTarget(_ path: String?) {
        presentWithoutAnimation { folderDeleteTarget = path }
    }

    func setFolderRenameTarget(_ path: String?) {
        presentWithoutAnimation {
            folderRenameTarget = path
            renameFolderName = path?.split(separator: "/").last.map(String.init) ?? ""
        }
    }
}
