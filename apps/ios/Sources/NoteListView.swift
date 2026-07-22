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
            .navigationTitle("Notes")
            .searchable(text: $search, prompt: "Search notes")
            .task(id: search) {
                await runSearch()
            }
            .toolbar {
                // Distinct ToolbarItem `id:`s so the two leading controls expose
                // as SEPARATE accessibility elements instead of collapsing into
                // one unlabeled container (VoiceOver/idb couldn't read or tap
                // them). [nav.md:13]
                ToolbarItem(id: "settings", placement: .topBarLeading) {
                    Button {
                        showSettings = true
                    } label: {
                        Image(systemName: "gearshape")
                    }
                    .tint(Theme.primary)
                    .accessibilityLabel("Settings")
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
                    .accessibilityLabel("Sync")
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
            .confirmationDialog(
                "Delete this note? This action cannot be undone.",
                isPresented: $showSearchDelete, titleVisibility: .visible
            ) {
                Button("Delete Note", role: .destructive) {
                    for id in searchDeleteIds { store.delete(id) }
                    searchDeleteIds = []
                }
                Button("Cancel", role: .cancel) { searchDeleteIds = [] }
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
                Text(message)
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
        .animation(.easeInOut(duration: 0.2), value: store.transientMessage)
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
                    Text("No matches")
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
        searchDeleteIds = offsets.map { filtered[$0].id }
        showSearchDelete = true
    }
}

/// Lists the immediate subfolders and notes of a single folder. Recursive:
/// tapping a subfolder pushes another FolderContentsView via Route.folder.
struct FolderContentsView: View {
    @EnvironmentObject private var store: NotesStore
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

    /// Subfolder path pending deletion (drives the destructive confirmation).

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
        !newFolderClean.isEmpty && subfolders.contains { child in
            (child.split(separator: "/").last.map(String.init) ?? child)
                .lowercased() == newFolderClean.lowercased()
        }
    }

    /// True when the typed name only survives sanitization via the "Untitled"
    /// fallback (sanitizeTitle's note-title contract turns "", "///", "..."
    /// into "Untitled"). Creating then would silently make a folder the user
    /// never named — treat it as invalid instead (2026-07-02 QA: "///" created
    /// an "Untitled" folder). Literally typing "Untitled" stays allowed.
    private var newFolderSanitizesAway: Bool {
        newFolderClean == "Untitled"
            && newFolderName.trimmingCharacters(in: .whitespacesAndNewlines) != "Untitled"
    }

    private var title: String {
        folder.isEmpty ? "Notes" : (folder.split(separator: "/").last.map(String.init) ?? folder)
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
            ToolbarItem(id: "create", placement: .topBarTrailing) {
                Menu {
                    Button {
                        // Quick capture: create + open straight into the body,
                        // no blocking title prompt (desktop parity). [list.md]
                        createNote()
                    } label: {
                        Label("New Note", systemImage: "square.and.pencil")
                    }
                    Button {
                        newFolderName = ""
                        setNewFolderDialog(visible: true)
                    } label: {
                        Label("New Folder", systemImage: "folder.badge.plus")
                    }
                } label: {
                    Image(systemName: "plus")
                }
                .tint(Theme.primary)
                // Explicit AX so VoiceOver/idb can read + activate the create
                // menu (it otherwise collapses into an unlabeled container).
                // [nav.md:13]
                .accessibilityLabel("New note or folder")
                .accessibilityAddTraits(.isButton)
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
                message: newFolderIsDuplicate
                    ? "A folder with this name already exists"
                    : (newFolderSanitizesAway
                        && !newFolderName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                        ? "Enter a valid folder name"
                        : "Create a folder in \(folder.isEmpty ? "Notes" : title)."),
                messageIsWarning: newFolderIsDuplicate
                    || (newFolderSanitizesAway
                        && !newFolderName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty),
                name: $newFolderName,
                // Mirror Android: Create is disabled on an empty, sanitize-away,
                // or case-insensitive-duplicate sibling name (NewFolderDialog.kt).
                canCreate: !newFolderClean.isEmpty && !newFolderIsDuplicate
                    && !newFolderSanitizesAway,
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
        .confirmationDialog(
            "Delete this note? This action cannot be undone.",
            isPresented: Binding(
                get: { deleteTarget != nil },
                set: { if !$0 { deleteTarget = nil } }),
            titleVisibility: .visible
        ) {
            Button("Delete Note", role: .destructive) {
                if let note = deleteTarget { store.delete(note.id) }
                deleteTarget = nil
            }
            Button("Cancel", role: .cancel) { deleteTarget = nil }
        }
        .confirmationDialog(
            "Delete this folder? Notes inside it will be moved to the parent folder.",
            isPresented: Binding(
                get: { folderDeleteTarget != nil },
                set: { if !$0 { folderDeleteTarget = nil } }),
            titleVisibility: .visible
        ) {
            Button("Delete Folder", role: .destructive) {
                if let target = folderDeleteTarget { store.deleteFolder(target) }
                folderDeleteTarget = nil
            }
            Button("Cancel", role: .cancel) { folderDeleteTarget = nil }
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
                                folderDeleteTarget = child
                            } label: {
                                Label("Delete Folder…", systemImage: "trash")
                            }
                        }
                        .contextMenu {
                            Button(role: .destructive) {
                                folderDeleteTarget = child
                            } label: {
                                Label("Delete Folder…", systemImage: "trash")
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
                                deleteTarget = note
                            } label: {
                                Label("Delete", systemImage: "trash")
                            }
                            Button {
                                moveTarget = note
                            } label: {
                                Label("Move", systemImage: "folder")
                            }
                            .tint(Theme.primary)
                        }
                        .contextMenu {
                            Button {
                                moveTarget = note
                            } label: {
                                Label("Move to Folder…", systemImage: "folder")
                            }
                            Button(role: .destructive) {
                                deleteTarget = note
                            } label: {
                                Label("Delete", systemImage: "trash")
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
            Text(folder.isEmpty ? "No notes yet" : "Empty folder")
                .font(.title2.bold())
            Text("Tap + to add a note or folder.")
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
        let clean = newFolderClean
        guard !clean.isEmpty, !newFolderIsDuplicate, !newFolderSanitizesAway else { return }
        store.createFolder(folder.isEmpty ? clean : folder + "/" + clean)
    }

    /// Show/hide the New Folder dialog with presentation animations disabled,
    /// so its transparent fullScreenCover pops in place like the .alert it
    /// replaced instead of playing the cover's default slide-up.
    private func setNewFolderDialog(visible: Bool) {
        var transaction = Transaction()
        transaction.disablesAnimations = true
        withTransaction(transaction) { showingNewFolder = visible }
    }
}

/// Alert-look-alike card for creating a folder, hosted in a transparent
/// `fullScreenCover`. Exists because `.alert` snapshots its `message:` closure
/// when presented — the case-insensitive duplicate warning (list.md:182) must
/// update live while the user types, which only real view content does.
/// Mirrors Android's NewFolderDialog.kt: inline duplicate error, Create
/// disabled on empty/duplicate names.
private struct NewFolderDialog: View {
    /// Live status line under the title: the create hint or, on a
    /// case-insensitive sibling collision, the duplicate warning.
    let message: String
    /// Whether `message` is the duplicate warning (rendered in danger red).
    let messageIsWarning: Bool
    @Binding var name: String
    let canCreate: Bool
    let onCancel: () -> Void
    let onCreate: () -> Void

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
                    Text("New Folder")
                        .font(.headline)
                    Text(message)
                        .font(.footnote)
                        .foregroundStyle(messageIsWarning ? Theme.danger : Color.secondary)
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                    TextField("Folder name", text: $name)
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
                        Text("Cancel")
                            .fontWeight(.semibold)
                            .frame(maxWidth: .infinity, minHeight: 44)
                    }
                    Divider()
                        .frame(height: 44)
                    Button(action: onCreate) {
                        Text("Create")
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

    let note: NoteItem
    /// Folder currently being browsed — used as the parent for a brand-new
    /// folder created from this sheet.
    let currentFolder: String
    /// Invoked with the note's FINAL id once the move lands (a move changes the
    /// id). The open editor uses this to keep the note open under its new id.
    var onMoved: ((String) -> Void)? = nil

    @State private var showingNewFolder = false
    @State private var newFolderName = ""

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Button {
                        move(to: "")
                    } label: {
                        rowLabel(text: "Root", system: "house.fill",
                                 isCurrent: note.folder.isEmpty)
                    }
                }
                if !store.folders.isEmpty {
                    Section("Folders") {
                        ForEach(store.folders, id: \.self) { path in
                            Button {
                                move(to: path)
                            } label: {
                                rowLabel(text: path, system: "folder.fill",
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
                        Label("New Folder…", systemImage: "folder.badge.plus")
                            .foregroundStyle(Theme.primary)
                    }
                }
            }
            .navigationTitle("Move \"\(note.title)\"")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel") { dismiss() }
                        .tint(Theme.primary)
                }
            }
            .alert("New Folder", isPresented: $showingNewFolder) {
                TextField("Folder name", text: $newFolderName)
                Button("Cancel", role: .cancel) {}
                Button("Create & Move") { createAndMove() }
            } message: {
                Text("Create a folder\(currentFolder.isEmpty ? "" : " in \(currentFolder)") and move the note into it.")
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
        Task {
            let finalId = await store.moveNote(note.id, toFolder: folder)
            onMoved?(finalId)
        }
        dismiss()
    }

    private func createAndMove() {
        let name = newFolderName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return }
        let dest = currentFolder.isEmpty ? name : currentFolder + "/" + name
        Task {
            let finalId = await store.moveNote(note.id, toFolder: dest)
            onMoved?(finalId)
        }
        dismiss()
    }
}

struct NoteRow: View {
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
                Text(note.modified, format: .relative(presentation: .named))
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
    /// back to the raw string if markdown parsing ever fails.
    private var richPreview: AttributedString {
        let options = AttributedString.MarkdownParsingOptions(
            interpretedSyntax: .inlineOnlyPreservingWhitespace,
            failurePolicy: .returnPartiallyParsedIfPossible)
        return (try? AttributedString(markdown: note.richPreview, options: options))
            ?? AttributedString(note.richPreview)
    }
}
