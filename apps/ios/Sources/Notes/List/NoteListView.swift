import SwiftUI

/// A navigation destination in the folder browser: either a folder to browse
/// into, or a note to open in the editor.
enum Route: Hashable {
    case folder(String)
    case note(String)
    /// A just-created note — opens with the editor focused + keyboard up.
    case newNote(String)
}

struct NoteListView: View {
    @EnvironmentObject private var store: NotesStore
    @EnvironmentObject private var sync: SyncManager
    @Environment(\.localization) private var localization
    @State private var search = ""
    @State private var navPath: [Route] = []
    @State private var showSync = false
    @State private var showSettings = false
    /// Note ids pending the search-results delete confirmation.
    @State private var searchDeleteIds: [String] = []
    @State private var showSearchDelete = false
    /// Results returned by the Rust-owned local-note store.
    @State private var searchHits: [NoteItem] = []

    private var filtered: [NoteItem] {
        let q = search.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !q.isEmpty else { return store.notes }
        return searchHits
    }

    var body: some View {
        NavigationStack(path: $navPath) {
            Group {
                if !search.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    // Search bypasses the folder browser: a flat, cross-folder
                    // list of matching notes.
                    searchResults
                } else {
                    // Root folder browser.
                    FolderContentsView(folder: "", navPath: $navPath)
                }
            }
            .background(Theme.background)
            .navigationTitle(localization.localizedText("notes.heading"))
            .searchable(text: $search, prompt: localization.localizedText("search.ios.placeholder"))
            .task(id: search) {
                await runSearch()
            }
            .toolbar {
                // Distinct ToolbarItem `id:`s so the two leading controls expose
                // as SEPARATE accessibility elements instead of collapsing into
                // one unlabeled container. Confirmed reaching the AX tree with
                // labels and identifiers on iOS 26.5 (see nav.md); an earlier
                // report that they did not was `idb` returning a shallow tree.
                ToolbarItem(id: "settings", placement: .topBarLeading) {
                    Button {
                        showSettings = true
                    } label: {
                        Image(systemName: "gearshape")
                    }
                    .tint(Theme.primary)
                    .accessibilityLabel(localization.localizedText("settings.heading"))
                    .accessibilityAddTraits(.isButton)
                    .accessibilityIdentifier("nav-settings")
                }
                ToolbarItem(id: "sync", placement: .topBarLeading) {
                    Button {
                        showSync = true
                    } label: {
                        Image(systemName: sync.connected ? "checkmark.icloud" : "icloud")
                    }
                    .tint(Theme.primary)
                    .accessibilityLabel(localization.localizedText("sync.heading"))
                    .accessibilityAddTraits(.isButton)
                    .accessibilityIdentifier("nav-sync")
                }
            }
            .sheet(isPresented: $showSync) {
                SyncView()
                    .environmentObject(sync)
                    .environmentObject(store)
            }
            .sheet(isPresented: $showSettings) {
                SettingsView()
                    .environmentObject(sync)
                    .environmentObject(store)
            }
            // Centered fullScreenCover, not a .confirmationDialog — see
            // DestructiveConfirmDialog for why (arrow-popover misanchoring).
            .fullScreenCover(isPresented: $showSearchDelete) {
                DestructiveConfirmDialog(
                    message: localization.localizedText(
                        "notes.delete.thisNoteRecoverableConfirmation"
                    ),
                    destructiveLabel: localization.localizedText("notes.actions.deleteNote"),
                    onCancel: { setSearchDelete([], visible: false) },
                    onDestructive: {
                        for id in searchDeleteIds { store.deleteAsync(id) }
                        setSearchDelete([], visible: false)
                    }
                )
                .presentationBackground(.clear)
            }
            .navigationDestination(for: Route.self) { route in
                switch route {
                case .folder(let path):
                    FolderContentsView(folder: path, navPath: $navPath)
                        .environmentObject(store)
                case .note(let id):
                    // .id(id): a wikilink tap PUSHES a new editor entry
                    // (openLinkedNote), so several .note editors can sit in the
                    // stack at once. Each needs its own identity or SwiftUI would
                    // share one view's @State (title, content, loaded) across the
                    // whole chain and Back would show the wrong note's text.
                    NoteEditorView(noteId: id, autoFocus: false, navPath: $navPath)
                        .environmentObject(store)
                        .id(id)
                case .newNote(let id):
                    NoteEditorView(noteId: id, autoFocus: true, navPath: $navPath)
                        .environmentObject(store)
                        .id(id)
                }
            }
        }
        // Transient status banner (e.g. "peer deleted the open note"), shown over
        // the whole stack including a pushed editor. iOS has no global toast, so
        // this is the minimal equivalent; driven by `store.showTransient`.
        .overlay(alignment: .bottom) {
            if let message = store.transientMessage {
                Text(localization.localizedText(message.path, arguments: message.arguments))
                    .font(.subheadline)
                    .foregroundStyle(.white)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
                    .background(Capsule().fill(Color.black.opacity(0.82)))
                    .padding(.bottom, 32)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                    .allowsHitTesting(false)
            }
        }
        .animation(.easeInOut(duration: 0.2), value: store.transientMessage?.path)
    }

    private func runSearch() async {
        let q = search.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty else {
            searchHits = []
            return
        }
        let hits = await store.search(q, limit: 50)
        // Map hits back to live NoteItems; drop ids the store doesn't know
        // (stale index entries disappear instead of rendering ghosts).
        let byId = Dictionary(store.notes.map { ($0.id, $0) }) { first, _ in first }
        let items = hits.compactMap { byId[$0.noteId] }
        // The query may have moved on while we were off-main — don't show stale
        // hits (.task(id:) cancellation usually catches this; belt-and-braces).
        guard q == search.trimmingCharacters(in: .whitespacesAndNewlines) else { return }
        searchHits = items
    }

    private var searchResults: some View {
        Group {
            if filtered.isEmpty {
                VStack(spacing: 16) {
                    Image(systemName: "magnifyingglass")
                        .font(.system(size: 48))
                        .foregroundStyle(Theme.primary)
                    Text(localization.localizedText("search.noMatches"))
                        .font(.title3.bold())
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                List {
                    ForEach(filtered) { note in
                        NavigationLink(value: Route.note(note.id)) {
                            NoteRow(note: note, showFolder: true)
                        }
                        .listRowBackground(Theme.surface)
                    }
                    .onDelete(perform: deleteSearchRows)
                }
                .listStyle(.insetGrouped)
                .scrollContentBackground(.hidden)
            }
        }
    }

    private func deleteSearchRows(_ offsets: IndexSet) {
        // Destructive: stash the ids and confirm before deleting (list.md).
        setSearchDelete(offsets.map { filtered[$0].id }, visible: true)
    }

    /// Sets the search-results delete-confirmation target without the
    /// implicit slide-up transition (see `presentWithoutAnimation`).
    private func setSearchDelete(_ ids: [String], visible: Bool) {
        presentWithoutAnimation {
            searchDeleteIds = ids
            showSearchDelete = visible
        }
    }
}

/// Lists the immediate subfolders and notes of a single folder. Recursive:
/// tapping a subfolder pushes another FolderContentsView via Route.folder.
struct FolderContentsView: View {
    @EnvironmentObject private var store: NotesStore
    @Environment(\.localization) private var localization
    /// The folder this view shows ("" = root).
    let folder: String
    @Binding var navPath: [Route]

    @State private var showingNewFolder = false
    @State private var newFolderName = ""

    /// Note being moved (drives the move sheet).
    @State private var moveTarget: NoteItem?
    /// Note pending the delete confirmation (swipe / context menu).
    @State private var deleteTarget: NoteItem?
    /// Subfolder pending the delete-folder confirmation.
    @State private var folderDeleteTarget: String?
    /// Subfolder being renamed or moved.
    @State private var folderRenameTarget: String?
    @State private var renameFolderName = ""
    @State private var folderMoveTarget: String?

    private var subfolders: [String] { store.subfolders(of: folder) }
    private var notes: [NoteItem] { store.notes(in: folder) }

    /// The new-folder name run through the SAME Rust filename rules a note title
    /// uses (a folder name is a path segment). "" once trimmed/sanitized away.
    private var newFolderClean: String {
        sanitizeTitle(title: newFolderName.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    /// Whether `newFolderClean` collides (case-insensitively) with an existing
    /// sibling folder. Rust `create_folder` is `create_dir_all` (idempotent), so
    /// without this guard creating "Specs" when "specs" exists would silently
    /// MERGE into the existing folder. Same lastPathComponent comparison Android
    /// uses (NewFolderDialog.kt). [list.md:152]
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

    private var canCreateNewFolder: Bool {
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
    private var canRenameFolder: Bool {
        renameFolderProblem == nil && !renameFolderIsDuplicate
            && renamedFolderPath != folderRenameTarget
    }

    private var renamedFolderPath: String {
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
        }
        // NOT a .alert: an alert snapshots its message: closure at presentation,
        // so the duplicate warning required by list.md:182 never appeared while
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
            MoveToFolderSheet(note: note, currentFolder: folder)
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
                message: localization.localizedText("folders.delete.recoverableConfirmation"),
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

    private var list: some View {
        List {
            if !subfolders.isEmpty {
                Section {
                    ForEach(subfolders, id: \.self) { child in
                        NavigationLink(value: Route.folder(child)) {
                            Label {
                                Text(child.split(separator: "/").last.map(String.init) ?? child)
                                    .font(.headline)
                            } icon: {
                                Image(systemName: "folder.fill")
                                    .foregroundStyle(Theme.primary)
                            }
                        }
                        .listRowBackground(Theme.surface)
                        // allowsFullSwipe off: a destructive full swipe animates
                        // the row away even though we only show a confirmation.
                        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                            Button(role: .destructive) {
                                setFolderDeleteTarget(child)
                            } label: {
                                Label(
                                    localization.localizedText(
                                        "folders.actions.deleteFolderEllipsis"
                                    ),
                                    systemImage: "trash"
                                )
                            }
                        }
                        .contextMenu {
                            Button {
                                setFolderRenameTarget(child)
                            } label: {
                                Label(
                                    localization.localizedText("common.actions.rename"),
                                    systemImage: "pencil"
                                )
                            }
                            Button {
                                folderMoveTarget = child
                            } label: {
                                Label(
                                    localization.localizedText(
                                        "folders.actions.moveToFolderEllipsis"
                                    ),
                                    systemImage: "folder"
                                )
                            }
                            Button(role: .destructive) {
                                setFolderDeleteTarget(child)
                            } label: {
                                Label(
                                    localization.localizedText(
                                        "folders.actions.deleteFolderEllipsis"
                                    ),
                                    systemImage: "trash"
                                )
                            }
                        }
                    }
                }
            }
            if !notes.isEmpty {
                Section {
                    ForEach(notes) { note in
                        NavigationLink(value: Route.note(note.id)) {
                            NoteRow(note: note, showFolder: false)
                        }
                        .listRowBackground(Theme.surface)
                        // allowsFullSwipe off — see the folder rows above.
                        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                            Button(role: .destructive) {
                                setDeleteTarget(note)
                            } label: {
                                Label(
                                    localization.localizedText("common.actions.delete"),
                                    systemImage: "trash"
                                )
                            }
                            Button {
                                moveTarget = note
                            } label: {
                                Label(
                                    localization.localizedText("common.actions.move"),
                                    systemImage: "folder"
                                )
                            }
                            .tint(Theme.primary)
                        }
                        .contextMenu {
                            Button {
                                moveTarget = note
                            } label: {
                                Label(
                                    localization.localizedText(
                                        "notes.actions.moveToFolderEllipsis"
                                    ),
                                    systemImage: "folder"
                                )
                            }
                            Button(role: .destructive) {
                                setDeleteTarget(note)
                            } label: {
                                Label(
                                    localization.localizedText("common.actions.delete"),
                                    systemImage: "trash"
                                )
                            }
                        }
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
    }

    private var emptyState: some View {
        VStack(spacing: 16) {
            Image(systemName: folder.isEmpty ? "note.text" : "folder")
                .font(.system(size: 56))
                .foregroundStyle(Theme.primary)
            Text(
                folder.isEmpty
                    ? localization.localizedText("notes.list.rootEmptyHeading")
                    : localization.localizedText("notes.list.folderEmptyHeading")
            )
            .font(.title2.bold())
            Text(localization.localizedText("notes.list.ios.emptyActionHint"))
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func createNote() {
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

    private func createFolder() {
        // Hard guard behind the disabled Create button: never call through to
        // the idempotent Rust create_dir_all on an empty name or a
        // case-insensitive sibling collision — that would silently MERGE into
        // the existing folder. [list.md:152]
        guard canCreateNewFolder else { return }
        let clean = newFolderClean
        store.createFolder(folder.isEmpty ? clean : folder + "/" + clean)
    }

    private func renameFolder() {
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
    private func setNewFolderDialog(visible: Bool) {
        presentWithoutAnimation { showingNewFolder = visible }
    }

    /// Sets/clears the note delete-confirmation target without the implicit
    /// slide-up transition (see `presentWithoutAnimation`).
    private func setDeleteTarget(_ note: NoteItem?) {
        presentWithoutAnimation { deleteTarget = note }
    }

    /// Sets/clears the folder delete-confirmation target without the implicit
    /// slide-up transition (see `presentWithoutAnimation`).
    private func setFolderDeleteTarget(_ path: String?) {
        presentWithoutAnimation { folderDeleteTarget = path }
    }

    private func setFolderRenameTarget(_ path: String?) {
        presentWithoutAnimation {
            folderRenameTarget = path
            renameFolderName = path?.split(separator: "/").last.map(String.init) ?? ""
        }
    }
}

/// Alert-look-alike card for creating a folder, hosted in a transparent
/// `fullScreenCover`. Exists because `.alert` snapshots its `message:` closure
/// when presented — the case-insensitive duplicate warning (list.md:182) must
/// update live while the user types, which only real view content does.
/// Mirrors Android's NewFolderDialog.kt: inline duplicate error, Create
/// disabled on empty/duplicate names.
private struct NewFolderDialog: View {
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
    /// Invoked with the note's FINAL id once the move lands (a move changes the
    /// id). The open editor uses this to keep the note open under its new id.
    var onMoved: ((String) -> Void)? = nil
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
            Task {
                if case .committed(let finalId) =
                    await store.moveNote(note.id, toFolder: folder)
                {
                    onMoved?(finalId)
                }
            }
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

struct MoveFolderSheet: View {
    @EnvironmentObject private var store: NotesStore
    @Environment(\.dismiss) private var dismiss
    @Environment(\.localization) private var localization

    let folder: String

    private var sourceParent: String {
        guard let slash = folder.lastIndex(of: "/") else { return "" }
        return String(folder[..<slash])
    }

    private var destinations: [String] {
        store.folders.filter { path in
            path != folder && !path.hasPrefix(folder + "/")
        }
    }

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
                            isCurrent: sourceParent.isEmpty
                        )
                    }
                }
                if !destinations.isEmpty {
                    Section(localization.localizedText("folders.heading")) {
                        ForEach(destinations, id: \.self) { path in
                            Button {
                                move(to: path)
                            } label: {
                                rowLabel(
                                    text: path,
                                    system: "folder.fill",
                                    isCurrent: sourceParent == path)
                            }
                        }
                    }
                }
            }
            .navigationTitle(
                localization.localizedText(
                    "folders.moveNamedHeading",
                    arguments: [
                        "folderName": folder.split(separator: "/").last.map(String.init) ?? folder
                    ]
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

    private func move(to destination: String) {
        Task {
            if await store.moveFolder(from: folder, destinationParent: destination) != nil {
                if destination.isEmpty {
                    store.showTransient(LocalizedMessage("folders.movedToRoot"))
                } else {
                    store.showTransient(
                        LocalizedMessage(
                            "folders.movedTo",
                            arguments: ["destination": destination]
                        )
                    )
                }
            } else {
                store.showTransient(LocalizedMessage("folders.errors.moveFailed"))
            }
        }
        dismiss()
    }
}

struct NoteRow: View {
    @Environment(\.localization) private var localization
    let note: NoteItem
    /// Whether to show the folder label (true in flat search results).
    var showFolder: Bool = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Text(note.title)
                    .font(.headline)
                    .lineLimit(1)
                Spacer()
                Text(
                    localization.localizedRelativeTime(
                        note.modified.timeIntervalSince1970 * 1_000
                    )
                )
                .font(.caption2)
                .foregroundStyle(.secondary)
            }
            if showFolder && !note.folder.isEmpty {
                Label(note.folder, systemImage: "folder")
                    .font(.caption2)
                    .foregroundStyle(Theme.primary)
            }
            if !note.richPreview.isEmpty {
                Text(richPreview)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(3)
            }
        }
        .padding(.vertical, 2)
    }

    /// The rich preview rendered as an `AttributedString`: inline `**bold**` /
    /// `*italic*` / `` `code` `` become real styling, and line breaks are kept
    /// (`.inlineOnlyPreservingWhitespace` parses only inline syntax — the block
    /// markdown was already rewritten into glyphs by `make_rich_preview`). Falls
    /// back to the raw string if markdown parsing ever fails. Link attributes
    /// the markdown parser auto-attaches to URL-shaped text are stripped —
    /// preview text sits inside a row wrapped in a NavigationLink, and an
    /// active `.link` run intercepts the tap, opening the URL instead of the
    /// note (list.md: preview text must never be actionable).
    private var richPreview: AttributedString {
        let options = AttributedString.MarkdownParsingOptions(
            interpretedSyntax: .inlineOnlyPreservingWhitespace,
            failurePolicy: .returnPartiallyParsedIfPossible)
        let parsed =
            (try? AttributedString(markdown: note.richPreview, options: options))
            ?? AttributedString(note.richPreview)
        return NoteRow.stripLinkAttributes(from: parsed)
    }

    /// Removes the `.link` attribute from every run, leaving other inline
    /// styling (bold/italic/code/strikethrough) untouched. Pulled out as a
    /// static, testable helper — see `NoteRowPreviewLinksTests`.
    static func stripLinkAttributes(from attributed: AttributedString) -> AttributedString {
        var result = attributed
        for run in result.runs where run.link != nil {
            result[run.range].link = nil
        }
        return result
    }
}
