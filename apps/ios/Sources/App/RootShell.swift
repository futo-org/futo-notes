import SwiftUI

/// Picks the shell for the window's size (``ShellLayout``): the phone stack, or the pages
/// shell on a foldable iPhone with the room for it. Both read the same `AppNavigation`
/// path, so the open folder and note carry across a fold or a rotation.
struct RootShell: View {
    @State private var window = RootShell.initialWindowSize
    @EnvironmentObject private var navigation: AppNavigation

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
        .environment(\.isDuoOuter, duoOuter)
        .environment(\.compactNoteRows, duoOuter)
        .environment(\.dropRepeatedPreviewTitle, duoOuter)
    }

    private var measuredShell: some View {
        shell(window: window, idiom: UIDevice.current.userInterfaceIdiom)
            .onGeometryChange(for: CGSize.self) { proxy in
                let insets = proxy.safeAreaInsets
                return CGSize(
                    width: proxy.size.width + insets.leading + insets.trailing,
                    height: proxy.size.height + insets.top + insets.bottom)
            } action: { size in
                resize(to: size)
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
        navigation.path = PagesPath.chain(PagesPath.folder(of: path))
        window = size
        // A just-created note reopens as an ordinary one: its quick-capture focus is spent.
        let reopened = path.map { route in
            if case .newNote(let id) = route { return Route.note(id) }
            return route
        }
        Task { @MainActor in navigation.path = reopened }
    }

    /// The key window's size at launch, so the first frame already has the right shell
    /// (a shell swap mid-launch would open and close the editor).
    private static var initialWindowSize: CGSize {
        UIApplication.shared.connectedScenes
            .compactMap { ($0 as? UIWindowScene)?.keyWindow?.bounds.size }
            .first ?? .zero
    }
}
