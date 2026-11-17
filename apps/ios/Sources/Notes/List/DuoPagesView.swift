import SwiftUI

/// What a list pane needs from the pages shell: rows open notes in the editor pane and pick
/// folders in place, and the folder column's actions reach the list's dialogs.
struct PaneHost {
    /// The note the editor pane shows; its row is highlighted.
    let openNoteId: String?
    /// False when the folder column beside the list already shows the folders.
    let showsSubfolders: Bool
    let open: (Route) -> Void
    let selectFolder: (String) -> Void
    /// Set by the folder column, performed and cleared by the list (FolderContentsView).
    let folderAction: Binding<FolderAction?>
    /// Called before the list deletes these notes (or every note under a folder): closes
    /// them in the editor pane first. False: one could not save yet, so do not delete.
    let closeEditor: (Set<String>, String?) async -> Bool
}

/// A folder dialog the folder column asks the list beside it to open.
enum FolderAction: Equatable {
    case create
    case rename(String)
    case move(String)
    case delete(String)
}

/// The navigation path read as the pages shell's state. The phone's path is
/// `[.folder…, .note…]`; here the last folder is the one the list shows and the notes after
/// it are the editor pane's stack. One path for both shells, so folding and unfolding keep
/// the folder and the open note, and the debug puppet listener drives either the same way.
enum PagesPath {
    static func folder(of path: [Route]) -> String {
        for route in path.reversed() {
            if case .folder(let folder) = route { return folder }
        }
        return ""
    }

    static func notes(of path: [Route]) -> [Route] {
        let start = path.lastIndex { if case .folder = $0 { true } else { false } }
        return Array(path[(start.map { $0 + 1 } ?? 0)...])
    }

    /// The pushes that reach `folder` from the root: "a/b" gives [a, a/b].
    static func chain(_ folder: String) -> [Route] {
        var chain: [Route] = []
        var prefix = ""
        for part in folder.split(separator: "/") {
            prefix = prefix.isEmpty ? String(part) : prefix + "/" + part
            chain.append(.folder(prefix))
        }
        return chain
    }

    static func noteId(_ route: Route?) -> String? {
        switch route {
        case .note(let id), .newNote(let id): id
        case .folder, nil: nil
        }
    }
}

/// The foldable iPhone's pages shell. Panes follow the hinge and the posture
/// (``PagesMode``): held like a book, folders and the folder's notes share the left page
/// and the note owns the right one, so nothing crosses the fold; held tall, the list sits
/// beside the note; half-folded tall (tabletop), the note takes the upright half and the
/// list the flat one, where the keyboard comes up; closed in landscape, a narrow list
/// beside the note.
struct DuoPagesView: View {
    @EnvironmentObject private var store: NotesStore
    @EnvironmentObject private var navigation: AppNavigation
    @Environment(\.localization) private var localization
    @Environment(\.displayScale) private var displayScale

    @State private var hingeIsFlat = HingeReader.initiallyFlat
    @State private var searchHits: [NoteItem] = []
    @State private var folderAction: FolderAction?
    /// The note the visible editor reports (it follows renames).
    /// Each editor screen's note as it is now, by the id the screen opened it with (renames
    /// and moves under the editor). Pruned to the screens on the stack.
    @State private var currentIds: [String: String] = [:]
    /// Notes the list is deleting while their editor closes (closeEditor).
    @State private var deleting: DeletingNotes?
    /// The whole window, keyboard or not (see body).
    @State private var windowSize = CGSize.zero

    /// The column the folder list takes on the book's left page.
    static let folderColumnWidth: CGFloat = 170
    /// The gutter left over a half-folded hinge, so nothing sits in the crease.
    static let creaseGutter: CGFloat = 16

    private var folder: String { PagesPath.folder(of: navigation.path) }
    private var noteRoutes: [Route] { PagesPath.notes(of: navigation.path) }

    /// The note the top editor screen shows now.
    private var visibleNoteId: String? {
        PagesPath.noteId(noteRoutes.last).map { currentIds[$0] ?? $0 }
    }

    private var openNoteId: String? { visibleNoteId }

    private var isSearching: Bool {
        !navigation.searchQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        GeometryReader { proxy in
            // The hinge runs through the window's middle. The window is measured by a
            // full-bleed background, never as this view plus its insets: the keyboard is
            // one of those insets, and it must not read as a smaller window.
            let origin = proxy.frame(in: .global).origin
            let window = windowSize == .zero ? proxy.size : windowSize
            let hinge = CGPoint(x: window.width / 2 - origin.x, y: window.height / 2 - origin.y)
            pages(
                PagesMode(window: window, hingeIsFlat: hingeIsFlat), size: proxy.size, hinge: hinge)
        }
        .background {
            Color.clear
                .onGeometryChange(for: CGSize.self) {
                    $0.size
                } action: { size in
                    windowSize = size
                }
                .ignoresSafeArea()
        }
        .background(HingeReader(isFlat: $hingeIsFlat))
        .background(Theme.background.ignoresSafeArea())
        .environment(\.reportVisibleNote) { currentIds[$0] = $1 }
        .environment(\.compactNoteRows, true)
        .environment(\.dropRepeatedPreviewTitle, true)
        .appSheets()
        .onChange(of: noteRoutes) { _, routes in
            let open = Set(routes.compactMap(PagesPath.noteId))
            currentIds = currentIds.filter { open.contains($0.key) }
        }
        // A folder that disappears under the list (deleted here, or by a peer) falls back
        // to its nearest surviving ancestor.
        .onChange(of: store.folders) { _, folders in
            var path = folder
            while !path.isEmpty, !folders.contains(path) { path = parentPath(of: path) }
            if path != folder { select(folder: path) }
        }
        .onChange(of: folderAction) { _, action in
            // The dialogs live in the folder list, which search replaces.
            if action != nil { navigation.searchQuery = "" }
        }
        .transientMessageBanner(store)
    }

    /// Every mode lays out the same views and only moves them (``PagesFrames``), so the
    /// editor pane keeps its identity, and its open note, across a posture change or a
    /// rotation. Rebuilding it would orphan the open editing session.
    private func pages(_ mode: PagesMode, size: CGSize, hinge: CGPoint) -> some View {
        let frames = PagesFrames(
            mode: mode, size: size, hinge: hinge, hingeIsFlat: hingeIsFlat,
            hairline: 1 / displayScale)
        return ZStack(alignment: .topLeading) {
            FolderColumn(
                selection: Binding(get: { folder }, set: { select(folder: $0) }),
                folderAction: $folderAction,
                onSync: { navigation.sheet = .sync },
                onSettings: { navigation.sheet = .settings }
            )
            .placed(in: frames.folders)
            Color(uiColor: .separator).placed(in: frames.folderSeam)
            listPane(showsSubfolders: mode != .book, footer: mode != .book)
                .placed(in: frames.list)
            Color(uiColor: frames.seamIsGutter ? .secondarySystemBackground : .separator)
                .placed(in: frames.seam)
            editorPane.placed(in: frames.editor)
        }
        .frame(width: size.width, height: size.height, alignment: .topLeading)
    }

    // MARK: - List pane

    private func listPane(showsSubfolders: Bool, footer: Bool) -> some View {
        NavigationStack {
            VStack(spacing: 0) {
                PaneSearchField(text: $navigation.searchQuery)
                if isSearching {
                    searchResults
                } else {
                    FolderContentsView(
                        folder: folder,
                        navPath: .constant([]),
                        pane: PaneHost(
                            openNoteId: openNoteId,
                            showsSubfolders: showsSubfolders,
                            open: open,
                            selectFolder: { select(folder: $0) },
                            folderAction: $folderAction,
                            closeEditor: { await closeEditor(showing: $0, under: $1) })
                    )
                    .id(folder)
                }
            }
            .background(Theme.background)
            .navigationBarTitleDisplayMode(.inline)
            .toolbarTitleMenu { folderMenu }
            .task(id: navigation.searchQuery) { await runSearch() }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if footer {
                ShellFooter(
                    onSync: { navigation.sheet = .sync },
                    onSettings: { navigation.sheet = .settings },
                    onNewFolder: { presentWithoutAnimation { folderAction = .create } })
            }
        }
    }

    /// The title's menu: every folder, to jump the list there.
    @ViewBuilder
    private var folderMenu: some View {
        Button {
            select(folder: "")
        } label: {
            if folder.isEmpty {
                Label(localization.localizedText("notes.heading"), systemImage: "checkmark")
            } else {
                Text(localization.localizedText("notes.heading"))
            }
        }
        ForEach(store.folders, id: \.self) { path in
            let name = path.split(separator: "/").joined(separator: " / ")
            Button {
                select(folder: path)
            } label: {
                if path == folder {
                    Label(name, systemImage: "checkmark")
                } else {
                    Text(name)
                }
            }
        }
    }

    private var searchResults: some View {
        Group {
            if searchHits.isEmpty {
                ContentUnavailableView(
                    localization.localizedText("search.noMatches"), systemImage: "magnifyingglass")
            } else {
                List(searchHits) { note in
                    Button {
                        open(.note(note.id))
                    } label: {
                        NoteRow(note: note, showFolder: true)
                    }
                    .foregroundStyle(Color(uiColor: .label))
                    .listRowBackground(note.id == openNoteId ? Theme.selectionFill : Theme.surface)
                    .accessibilityIdentifier(ListRowID.note(note.id))
                }
                .listStyle(.insetGrouped)
                .scrollContentBackground(.hidden)
            }
        }
        .navigationTitle(localization.localizedText("notes.heading"))
    }

    private func runSearch() async {
        let query = navigation.searchQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else {
            searchHits = []
            return
        }
        let hits = await store.search(query, limit: 50)
        let byId = Dictionary(store.notes.map { ($0.id, $0) }) { first, _ in first }
        guard query == navigation.searchQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        else { return }
        searchHits = hits.compactMap { byId[$0.noteId] }
    }

    // MARK: - Editor pane

    /// The note routes as the editor pane's stack: the first is the pane's root (no Back;
    /// the list beside it is the way out), the rest are wikilink pushes Back walks.
    private var editorRoutes: Binding<[Route]> {
        Binding(
            get: { PagesPath.notes(of: navigation.path) },
            set: { navigation.path = PagesPath.chain(folder) + $0 })
    }

    private var editorPane: some View {
        let routes = noteRoutes
        return NavigationStack(
            path: Binding(
                get: { Array(routes.dropFirst()) },
                set: { editorRoutes.wrappedValue = Array(editorRoutes.wrappedValue.prefix(1)) + $0 }
            )
        ) {
            Group {
                if let first = routes.first {
                    noteScreen(first)
                } else {
                    NoNoteSelectedView(onNewNote: newNote)
                }
            }
            .navigationDestination(for: Route.self) { noteScreen($0) }
        }
    }

    @ViewBuilder
    private func noteScreen(_ route: Route) -> some View {
        switch route {
        case .note(let id), .newNote(let id):
            // .id(id): a fresh screen per note (see NoteListView). Replacing the root
            // makes the old screen disappear, which saves and closes it.
            TextFirstNoteScreen(noteId: id, autoFocus: route == .newNote(id), navPath: editorRoutes)
                .id(id)
        case .folder:
            EmptyView()
        }
    }

    // MARK: - Actions

    private func select(folder new: String) {
        navigation.path = PagesPath.chain(new) + noteRoutes
    }

    /// A note already on the editor pane's stack (by the id it has now) is popped back to,
    /// never rebuilt: its screen keeps its place, and a screen moved to another place would
    /// not save first. Any other note replaces the stack, and each screen it removes leaves
    /// (saves). Notes the list is deleting do not open.
    private func open(_ route: Route) {
        guard let id = PagesPath.noteId(route), deleting?.covers(id) != true else { return }
        let routes = noteRoutes
        let current = routes.compactMap(PagesPath.noteId).map { currentIds[$0] ?? $0 }
        // From the top down: the nearest screen showing the note wins (a stack can hold
        // two screens opened under one id, and then only the top one's id is current).
        if let index = current.lastIndex(of: id) {
            if index < routes.count - 1 { editorRoutes.wrappedValue = Array(routes[...index]) }
            return
        }
        if routes.contains(where: { PagesPath.noteId($0) == id }) {
            // A screen opened under this id holds another note now (renamed away, and a new
            // note took the name): empty the pane first, or the same route keeps that screen.
            editorRoutes.wrappedValue = []
            Task { @MainActor in editorRoutes.wrappedValue = [route] }
        } else {
            editorRoutes.wrappedValue = [route]
        }
    }

    /// Before the list deletes notes (or every note under a folder), the editor pane closes
    /// any of them it shows and waits for each save and detach, as Back would; a closed
    /// editor still saving one of them is waited for too. False when a save has not landed
    /// after a few seconds: the delete waits for the user to retry, so it never drops a
    /// draft. Nothing reopens those notes meanwhile.
    private func closeEditor(showing ids: Set<String>, under folder: String?) async -> Bool {
        let target = DeletingNotes(ids: ids, folder: folder)
        deleting = target
        defer { deleting = nil }
        let opened = noteRoutes.compactMap(PagesPath.noteId)
        let shown = opened + opened.compactMap { currentIds[$0] }
        // A move from the list beside it can leave the editor's id behind: an id the vault
        // no longer has could be any note, so that editor closes too.
        let top = visibleNoteId
        let stale = top.map { id in !store.notes.contains { $0.id == id } } ?? false
        let closing = stale || shown.contains(where: target.covers)
        if closing {
            editorRoutes.wrappedValue = []
            // Its leave registers as the screen goes.
            try? await Task.sleep(for: .milliseconds(100))
        }
        for _ in 0..<50 {
            // A closing editor's leave names its note only once it settles, so wait for every
            // leave; otherwise only for those of these notes.
            let saving =
                closing
                ? TextFirstLeaves.unsettled > 0
                : TextFirstLeaves.leavingIds.contains(where: target.covers)
            if !saving { return true }
            try? await Task.sleep(for: .milliseconds(100))
        }
        return false
    }

    private func newNote() {
        Task {
            if let id = await store.createNote(title: "Untitled", folder: folder) {
                open(.newNote(id))
            }
        }
    }
}

/// Where each pane of the pages shell sits, in the shell's own coordinates. An empty rect
/// hides that pane.
struct PagesFrames: Equatable {
    var folders = CGRect.zero
    var folderSeam = CGRect.zero
    var list: CGRect
    /// A hairline between the list and the editor, or the gutter over a half-folded hinge.
    var seam: CGRect
    var seamIsGutter = false
    var editor: CGRect

    init(mode: PagesMode, size: CGSize, hinge: CGPoint, hingeIsFlat: Bool, hairline: CGFloat) {
        let width = size.width
        let height = size.height
        switch mode {
        case .book:
            let gutter = hingeIsFlat ? 0 : DuoPagesView.creaseGutter
            let left = max(0, hinge.x - gutter / 2)
            let column = DuoPagesView.folderColumnWidth
            folders = CGRect(x: 0, y: 0, width: column, height: height)
            folderSeam = CGRect(x: column, y: 0, width: hairline, height: height)
            list = CGRect(
                x: column + hairline, y: 0, width: max(0, left - column - hairline), height: height)
            let seamWidth = gutter > 0 ? gutter : hairline
            seam = CGRect(x: left, y: 0, width: seamWidth, height: height)
            seamIsGutter = gutter > 0
            editor = CGRect(
                x: left + seamWidth, y: 0, width: max(0, width - left - seamWidth), height: height)
        case .tall, .mini:
            let listWidth = mode == .mini ? min(280, width * 0.38) : min(320, width * 0.45)
            list = CGRect(x: 0, y: 0, width: listWidth, height: height)
            seam = CGRect(x: listWidth, y: 0, width: hairline, height: height)
            editor = CGRect(
                x: listWidth + hairline, y: 0, width: max(0, width - listWidth - hairline),
                height: height)
        case .tabletop:
            // The note keeps the upright half. The keyboard comes up over the flat half,
            // which the editor's frame never reaches, so the note does not move for it.
            let gutter = DuoPagesView.creaseGutter
            let top = max(0, hinge.y - gutter / 2)
            editor = CGRect(x: 0, y: 0, width: width, height: top)
            seam = CGRect(x: 0, y: top, width: width, height: gutter)
            seamIsGutter = true
            let below = top + gutter
            list = CGRect(x: 0, y: below, width: width, height: max(0, height - below))
        }
    }
}

extension View {
    /// Sizes and places a pane at `rect` in a top-leading ZStack; an empty rect hides it
    /// without removing it, so its identity and state survive a layout change.
    fileprivate func placed(in rect: CGRect) -> some View {
        frame(width: rect.width, height: rect.height)
            .offset(x: rect.minX, y: rect.minY)
            .opacity(rect.isEmpty ? 0 : 1)
            .allowsHitTesting(!rect.isEmpty)
            .accessibilityHidden(rect.isEmpty)
    }
}

/// The notes a list delete removes: some ids, or every note under a folder.
struct DeletingNotes: Equatable {
    let ids: Set<String>
    let folder: String?

    func covers(_ id: String) -> Bool {
        ids.contains(id) || folder.map { id.hasPrefix($0 + "/") } ?? false
    }
}
