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
        if let pane {
            pane.open(.newNote(id))
        } else {
            navPath.append(.newNote(id))
        }
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

    /// A capsule at the bottom that slides up, says what the folder delete kept, and leaves
    /// after about 3 s.
    func showKeptToast(count: Int, folderName: String) {
        keptToastTask?.cancel()
        let message = localization.localizedText(
            "folders.delete.keptToast",
            arguments: ["count": count, "folderName": folderName])
        withAnimation(.spring(response: 0.45, dampingFraction: 0.8)) { keptToast = message }
        keptToastTask = Task {
            try? await Task.sleep(for: .seconds(3))
            guard !Task.isCancelled else { return }
            withAnimation(.easeIn(duration: 0.25)) { keptToast = nil }
        }
    }

    /// Tints the notes a folder delete just moved here, then fades the tint after about 2 s,
    /// so the eye finds where they landed.
    func highlightArrivals(_ ids: [String]) {
        withAnimation(.easeOut(duration: 0.25)) { arrivedNoteIDs = Set(ids) }
        Task {
            try? await Task.sleep(for: .seconds(1.8))
            withAnimation(.easeInOut(duration: 1)) { arrivedNoteIDs = [] }
        }
    }

    @ViewBuilder var keptToastView: some View {
        if let message = keptToast {
            Text(message)
                .font(.system(.subheadline, weight: .medium))
                .multilineTextAlignment(.center)
                .padding(.horizontal, 18)
                .padding(.vertical, 12)
                .background(.regularMaterial, in: Capsule())
                .overlay(Capsule().strokeBorder(Color.primary.opacity(0.06), lineWidth: 0.5))
                .shadow(color: .black.opacity(0.14), radius: 15, y: 8)
                .padding(.horizontal, 24)
                .padding(.bottom, 40)
                .transition(.move(edge: .bottom).combined(with: .opacity))
                .accessibilityIdentifier("folder-kept-toast")
        }
    }
}
