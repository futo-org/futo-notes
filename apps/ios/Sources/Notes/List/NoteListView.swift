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
    /// Only to hand on to the Settings sheet, which owns the License row.
    @EnvironmentObject private var license: LicenseModel
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

    /// Whether any UIKit-level modal (a sheet or cover from this list, a
    /// folder row, the crash report) is already over the root. SwiftUI drops a
    /// presentation made while another is up, so the landing asks first.
    private static var modalIsPresented: Bool {
        UIApplication.shared.connectedScenes
            .compactMap { ($0 as? UIWindowScene)?.keyWindow }
            .contains { $0.rootViewController?.presentedViewController != nil }
    }

    private var filtered: [NoteItem] {
        guard !search.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return store.notes
        }
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
            .toolbar { sortToolbar }
            // The close ledger's first two marks: the path shrank (a system
            // pop, Back or the edge swipe, has been committed to the stack)
            // and the first screen refresh after it. Debug-only, no work in
            // release (CloseLedger.swift).
            .onChange(of: navPath.count) { before, after in
                guard after < before else { return }
                CloseLedger.mark("popObserved", note: "depth=\(after)")
                CloseLedger.markOnNextFrame("listFrame")
            }
            .onAppear { CloseLedger.installBenchTouchMarks() }
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
            // An activation that includes the app icon lands on the picker over
            // Settings. The landing is decided at activation time and never
            // kept: SettingsView takes it when it is already up; otherwise it is
            // presented here only if nothing else covers the list (a stray
            // flag would pop the picker, header and all, on a later manual
            // open). Skipped when the OS cannot change icons.
            .onChange(of: license.pendingLanding, initial: true) { _, pending in
                guard pending, !showSettings else { return }
                guard UIApplication.shared.supportsAlternateIcons, !Self.modalIsPresented else {
                    license.consumeLanding()
                    return
                }
                showSettings = true
            }
            // Backstop: whatever happened, closing Settings leaves no landing behind.
            .onChange(of: showSettings) { _, shown in
                if !shown { license.consumeLanding() }
            }
            .sheet(isPresented: $showSettings) {
                SettingsView()
                    .environmentObject(sync)
                    .environmentObject(store)
                    .environmentObject(license)
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
        .transientMessageBanner(store)
    }

    @ToolbarContentBuilder
    private var sortToolbar: some ToolbarContent {
        if #available(iOS 26, *) {
            ToolbarItem(placement: .bottomBar) { NoteSortMenu() }
            ToolbarSpacer(.fixed, placement: .bottomBar)
            DefaultToolbarItem(kind: .search, placement: .bottomBar)
        } else {
            ToolbarItem(placement: .topBarTrailing) { NoteSortMenu() }
        }
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
