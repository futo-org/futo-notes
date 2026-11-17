import SwiftUI

/// Picks the shell for the window's size (``ShellLayout``): the phone stack, or the pages
/// shell on a foldable iPhone with the room for it. Both read the same `AppNavigation`
/// path, so the open folder and note carry across a fold or a rotation.
struct RootShell: View {
    @State private var window = RootShell.initialWindowSize
    @EnvironmentObject private var navigation: AppNavigation
    /// Open notes renamed or moved under their editor, so a fold reopens them by their
    /// current id (the path keeps the id each was opened with).
    @State private var identities = NoteIdentities()
    @State private var handoff = ShellHandoff()

    var body: some View {
        #if FUTO_DEBUG_BUILD
            if let forced = Self.debugWindow {
                // `-FUTODebugWindow 951x669`: lay the shell out in a phone window of that
                // size, 1:1, centered on a bigger simulator. The simulator cannot unfold the
                // Duo; an iPad Pro 13" holds either open size.
                ZStack {
                    Color(uiColor: .systemGray4).ignoresSafeArea()
                    shell(window: forced, idiom: .phone)
                        .frame(width: forced.width, height: forced.height)
                        .clipShape(RoundedRectangle(cornerRadius: 28))
                }
                .task { applyDebugLaunch() }
            } else {
                measuredShell.task { applyDebugLaunch() }
            }
        #else
            measuredShell
        #endif
    }

    #if FUTO_DEBUG_BUILD
        /// `-FUTODebugOrientation landscape|portrait`: the simulator has no rotate command.
        /// `-FUTODebugOpenNote "Folder/Title"`: open with that note's folder and the note showing.
        private func applyDebugLaunch() {
            if let id = UserDefaults.standard.string(forKey: "FUTODebugOpenNote") {
                navigation.path = PagesPath.chain(splitId(id: id).folder) + [.note(id)]
            }
            guard let wanted = UserDefaults.standard.string(forKey: "FUTODebugOrientation")
            else { return }
            let mask: UIInterfaceOrientationMask =
                wanted == "landscape" ? .landscapeRight : .portrait
            for case let scene as UIWindowScene in UIApplication.shared.connectedScenes {
                scene.requestGeometryUpdate(.iOS(interfaceOrientations: mask))
            }
        }
    #endif

    private func shell(window: CGSize, idiom: UIUserInterfaceIdiom) -> some View {
        let layout = ShellLayout(size: window, idiom: idiom)
        let duoOuter = layout == .stack && ShellLayout.isDuoOuter(size: window, idiom: idiom)
        return Group {
            switch layout {
            case .stack: NoteListView()
            case .pages: DuoPagesView()
            }
        }
        .environment(\.reportNoteIdentity) { identities.record($0, as: $1) }
        .environment(\.shellHandoff, handoff)
        .environment(\.isDuoOuter, duoOuter)
        .environment(\.compactNoteRows, duoOuter)
        .environment(\.dropRepeatedPreviewTitle, duoOuter)
    }

    /// The window is measured by a full-bleed background: a keyboard coming up must never
    /// read as a smaller window (it would swap shells under the caret).
    private var measuredShell: some View {
        shell(window: window, idiom: UIDevice.current.userInterfaceIdiom)
            .background {
                Color.clear
                    .onGeometryChange(for: CGSize.self) {
                        $0.size
                    } action: { size in
                        resize(to: size)
                    }
                    .ignoresSafeArea()
            }
    }

    #if FUTO_DEBUG_BUILD
        private static let debugWindow: CGSize? = {
            let parts = (UserDefaults.standard.string(forKey: "FUTODebugWindow") ?? "")
                .split(separator: "x").compactMap { Double($0) }
            return parts.count == 2 ? CGSize(width: parts[0], height: parts[1]) : nil
        }()
    #endif

    /// A fold or unfold swaps shells, and the new shell builds its own editor. The open
    /// note's routes go first, so the old editor leaves the way Back makes it (saving and
    /// releasing its session); the next turn puts them back and the new shell reopens the
    /// note, taking over the draft that leave kept.
    private func resize(to size: CGSize) {
        let idiom = UIDevice.current.userInterfaceIdiom
        let routes = PagesPath.notes(of: navigation.path)
        guard ShellLayout(size: size, idiom: idiom) != ShellLayout(size: window, idiom: idiom),
            !routes.isEmpty
        else {
            window = size
            return
        }
        let path = navigation.path
        let interim = PagesPath.chain(PagesPath.folder(of: path))
        // By its current id if it was renamed or moved under its editor; a just-created
        // note stays new, so the new shell's screen still discards it if left untouched.
        let reopened = path.map { route in
            switch route {
            case .note(let id): Route.note(identities.current(id))
            case .newNote(let id): Route.newNote(identities.current(id))
            case .folder: route
            }
        }
        handoff.active = true
        navigation.path = interim
        window = size
        Task { @MainActor in
            handoff.active = false
            // Only while nothing else navigated in between (a note created meanwhile wins).
            if navigation.path == interim { navigation.path = reopened }
        }
    }

    /// The key window's size at launch, so the first frame already has the right shell
    /// (a shell swap mid-launch would open and close the editor).
    private static var initialWindowSize: CGSize {
        UIApplication.shared.connectedScenes
            .compactMap { ($0 as? UIWindowScene)?.keyWindow?.bounds.size }
            .first ?? .zero
    }
}

/// Where each note opened under an id has gone since (a rename or move under its editor).
final class NoteIdentities {
    private var moved: [String: String] = [:]

    func record(_ opened: String, as current: String) {
        moved[opened] = opened == current ? nil : current
    }

    func current(_ opened: String) -> String { moved[opened] ?? opened }
}
