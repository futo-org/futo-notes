import SwiftUI

extension FolderContentsView {
    /// The new note's id, or nil when the store refused it.
    @discardableResult
    func createNote() async -> String? {
        // Quick capture: name it "Untitled" and drop straight into the body.
        // No title prompt — the editor opens body-focused (.newNote →
        // autoFocus), the note is renamed later via the ⋯ menu, and an
        // untouched note is discarded on back-out (NoteEditorView.onDisappear).
        guard let id = await store.createNote(title: "Untitled", folder: folder) else {
            return nil
        }
        navPath.append(.newNote(id))
        return id
    }

    /// Whether the folder landed.
    func createFolder() async -> Bool {
        // Hard guard behind the disabled Create button: never call through to
        // the idempotent Rust create_dir_all on an empty name or a
        // case-insensitive sibling collision — that would silently MERGE into
        // the existing folder. [list.md]
        guard canCreateNewFolder else { return false }
        let clean = newFolderClean
        return await store.createFolder(folder.isEmpty ? clean : folder + "/" + clean)
    }

    /// Whether the rename landed.
    func renameFolder() async -> Bool {
        guard let target = folderRenameTarget else { return false }
        // Same hard guard as createFolder: the disabled Rename button must not
        // be the only thing standing between a rejected name and the engine.
        guard canRenameFolder else { return false }
        let destination = renamedFolderPath
        let renamed = await store.renameFolder(from: target, to: destination) != nil
        store.showTransient(
            LocalizedMessage(renamed ? "folders.renamed" : "folders.errors.renameFailed"))
        setFolderRenameTarget(nil)
        return renamed
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
