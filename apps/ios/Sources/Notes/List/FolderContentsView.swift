import SwiftUI

/// Lists the immediate subfolders and notes of a single folder. Recursive:
/// tapping a subfolder pushes another FolderContentsView via Route.folder.
struct FolderContentsView: View {
    @EnvironmentObject var store: NotesStore
    @Environment(\.localization) var localization
    /// The folder this view shows ("" = root).
    let folder: String
    @Binding var navPath: [Route]

    @State var showingNewFolder = false
    @State private var newFolderName = ""

    /// Note being moved (drives the move sheet).
    @State var moveTarget: NoteItem?
    /// Note pending the delete confirmation (swipe / context menu).
    @State var deleteTarget: NoteItem?
    /// Subfolder pending the delete-folder confirmation.
    @State var folderDeleteTarget: String?
    /// Subfolder being renamed or moved.
    @State var folderRenameTarget: String?
    @State var renameFolderName = ""
    @State var folderMoveTarget: String?

    var subfolders: [String] { store.subfolders(of: folder) }
    var notes: [NoteItem] { store.notes(in: folder) }

    /// The new-folder name run through the SAME Rust filename rules a note title
    /// uses (a folder name is a path segment). "" once trimmed/sanitized away.
    var newFolderClean: String {
        sanitizeTitle(title: newFolderName.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    /// Whether `newFolderClean` collides (case-insensitively) with an existing
    /// sibling folder. Rust `create_folder` is `create_dir_all` (idempotent), so
    /// without this guard creating "Specs" when "specs" exists would silently
    /// MERGE into the existing folder. Same lastPathComponent comparison Android
    /// uses (NewFolderDialog.kt). [list.md]
    private var newFolderIsDuplicate: Bool {
        !newFolderClean.isEmpty
            && subfolders.contains { child in
                (child.split(separator: "/").last.map(String.init) ?? child)
                    .lowercased() == newFolderClean.lowercased()
            }
    }

    /// The shared filename rules' verdict on the typed name — a forbidden
    /// character, an empty field, or a name that only survives sanitization via
    /// the "Untitled" fallback. See FolderNameValidation.swift; the rules
    /// themselves live in Rust.
    private var newFolderProblem: FolderNameProblem? {
        folderNameProblem(newFolderName)
    }

    /// Catalog path of the inline warning, or nil when the dialog shows its
    /// ordinary hint. A shared-rule violation is named before a sibling
    /// collision (desktop's order), and an empty field stays quiet.
    private var newFolderWarningPath: String? {
        if let problem = newFolderProblem { return problem.messagePath }
        return newFolderIsDuplicate ? "folders.duplicateName" : nil
    }

    var canCreateNewFolder: Bool {
        newFolderProblem == nil && !newFolderIsDuplicate
    }

    private var renameFolderClean: String {
        sanitizeTitle(title: renameFolderName.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    private var renameFolderParent: String {
        guard let target = folderRenameTarget, let slash = target.lastIndex(of: "/") else {
            return ""
        }
        return String(target[..<slash])
    }

    private var renameFolderIsDuplicate: Bool {
        guard let target = folderRenameTarget, !renameFolderClean.isEmpty else { return false }
        return store.subfolders(of: renameFolderParent).contains { child in
            child != target
                && (child.split(separator: "/").last.map(String.init) ?? child)
                    .lowercased() == renameFolderClean.lowercased()
        }
    }

    private var renameFolderProblem: FolderNameProblem? {
        folderNameProblem(renameFolderName)
    }

    private var renameFolderWarningPath: String? {
        if let problem = renameFolderProblem { return problem.messagePath }
        return renameFolderIsDuplicate ? "folders.duplicateName" : nil
    }

    /// A rename to the folder's own current path is a no-op, so it is blocked
    /// too — the only condition the create dialog does not share.
    var canRenameFolder: Bool {
        renameFolderProblem == nil && !renameFolderIsDuplicate
            && renamedFolderPath != folderRenameTarget
    }

    var renamedFolderPath: String {
        renameFolderParent.isEmpty
            ? renameFolderClean : renameFolderParent + "/" + renameFolderClean
    }

    private var title: String {
        folder.isEmpty
            ? localization.localizedText("notes.heading")
            : (folder.split(separator: "/").last.map(String.init) ?? folder)
    }

    private var isEmpty: Bool { subfolders.isEmpty && notes.isEmpty }

    /// Only show the "No notes yet" empty state once the first scan has landed.
    /// On a cold start the list is momentarily empty just because `bootstrap`
    /// hasn't completed; flashing the empty state then reads as data loss.
    /// (Subfolders are only reachable after bootstrap, so this only affects the
    /// root view's first frames.) See NotesStore.hasBootstrapped.
    private var showEmptyState: Bool { store.hasBootstrapped && isEmpty }

    var body: some View {
        Group {
            if showEmptyState {
                emptyState
            } else {
                list
            }
        }
        .background(Theme.background)
        .navigationTitle(title)
        .toolbar {
            // Two SEPARATE nav-bar buttons (desktop parity, github#5): a
            // folder button and a compose button, the way Notes/Files expose
            // them. New Note is one tap — quick capture never sits behind a
            // menu. iOS groups adjacent trailing items into one control
            // cluster, so this reads as native rather than as two loose icons.
            ToolbarItem(id: "create-folder", placement: .topBarTrailing) {
                Button {
                    newFolderName = ""
                    setNewFolderDialog(visible: true)
                } label: {
                    Image(systemName: "folder.badge.plus")
                }
                .tint(Theme.primary)
                // Explicit AX so VoiceOver/AXe can read + activate it. [nav.md]
                .accessibilityLabel(localization.localizedText("folders.newFolder"))
                .accessibilityIdentifier("nav-create-folder")
            }
            ToolbarItem(id: "create", placement: .topBarTrailing) {
                Button {
                    // Quick capture: create + open straight into the body,
                    // no blocking title prompt (desktop parity). [list.md]
                    createNote()
                } label: {
                    Image(systemName: "square.and.pencil")
                }
                .tint(Theme.primary)
                // Explicit AX so VoiceOver/AXe can read + activate it. [nav.md]
                .accessibilityLabel(localization.localizedText("notes.newNote"))
                .accessibilityIdentifier("nav-create")
            }
            // The root gets its sort item from NoteListView's own toolbar, which
            // also hosts the bottom-bar search field; only pushed folders add it here.
            if !folder.isEmpty {
                if #available(iOS 26, *) {
                    ToolbarItem(id: "sort", placement: .bottomBar) { NoteSortMenu() }
                } else {
                    ToolbarItem(id: "sort", placement: .topBarTrailing) { NoteSortMenu() }
                }
            }
        }
        // NOT a .alert: an alert snapshots its message: closure at presentation,
        // so the duplicate warning required by list.md never appeared while
        // typing (the Create button's .disabled kept re-evaluating; the message
        // didn't). A transparent fullScreenCover hosts real view content, which
        // re-renders live — the message flips to the warning as the user types.
        .fullScreenCover(isPresented: $showingNewFolder) {
            NewFolderDialog(
                title: localization.localizedText("folders.newFolderTitleCase"),
                confirmLabel: localization.localizedText("common.actions.create"),
                message: newFolderWarningPath.map { localization.localizedText($0) }
                    ?? (folder.isEmpty
                        ? localization.localizedText("folders.createInNotesPrompt")
                        : localization.localizedText(
                            "folders.createInFolderPrompt",
                            arguments: ["folderName": title]
                        )),
                messageIsWarning: newFolderWarningPath != nil,
                name: $newFolderName,
                // Create is disabled on any shared-rule violation or a
                // case-insensitive-duplicate sibling name. [list.md]
                canCreate: canCreateNewFolder,
                onCancel: { setNewFolderDialog(visible: false) },
                onCreate: {
                    createFolder()
                    setNewFolderDialog(visible: false)
                }
            )
            .presentationBackground(.clear)
        }
        .sheet(item: $moveTarget) { note in
            MoveToFolderSheet(note: note)
                .environmentObject(store)
        }
        .sheet(
            isPresented: Binding(
                get: { folderMoveTarget != nil },
                set: { if !$0 { folderMoveTarget = nil } })
        ) {
            if let target = folderMoveTarget {
                MoveFolderSheet(folder: target)
                    .environmentObject(store)
            }
        }
        .fullScreenCover(
            isPresented: Binding(
                get: { folderRenameTarget != nil },
                set: { if !$0 { setFolderRenameTarget(nil) } })
        ) {
            NewFolderDialog(
                title: localization.localizedText("folders.renameHeading"),
                confirmLabel: localization.localizedText("common.actions.rename"),
                message: renameFolderWarningPath.map { localization.localizedText($0) }
                    ?? localization.localizedText("folders.renamePrompt"),
                messageIsWarning: renameFolderWarningPath != nil,
                name: $renameFolderName,
                canCreate: canRenameFolder,
                onCancel: { setFolderRenameTarget(nil) },
                onCreate: { renameFolder() }
            )
            .presentationBackground(.clear)
        }
        // Centered fullScreenCover, not a .confirmationDialog — see
        // DestructiveConfirmDialog for why (arrow-popover misanchoring).
        .fullScreenCover(
            isPresented: Binding(
                get: { deleteTarget != nil },
                set: { if !$0 { setDeleteTarget(nil) } })
        ) {
            DestructiveConfirmDialog(
                message: localization.localizedText(
                    "notes.delete.thisNoteRecoverableConfirmation"
                ),
                destructiveLabel: localization.localizedText("notes.actions.deleteNote"),
                onCancel: { setDeleteTarget(nil) },
                onDestructive: {
                    if let note = deleteTarget { store.deleteAsync(note.id) }
                    setDeleteTarget(nil)
                }
            )
            .presentationBackground(.clear)
        }
        .fullScreenCover(
            isPresented: Binding(
                get: { folderDeleteTarget != nil },
                set: { if !$0 { setFolderDeleteTarget(nil) } })
        ) {
            DestructiveConfirmDialog(
                message: localization.localizedText(
                    "folders.delete.preservingContentsConfirmation"
                ),
                destructiveLabel: localization.localizedText("folders.actions.deleteFolder"),
                onCancel: { setFolderDeleteTarget(nil) },
                onDestructive: {
                    if let target = folderDeleteTarget { store.deleteFolder(target) }
                    setFolderDeleteTarget(nil)
                }
            )
            .presentationBackground(.clear)
        }
    }
}
