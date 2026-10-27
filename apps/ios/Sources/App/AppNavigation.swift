import SwiftUI

/// What the note list presents over the folder browser. One value, not one
/// `@State` per view, so the debug puppet listener can name the screen a user
/// sees and dismiss it the way Done does (PuppetServer+Verbs.swift).
enum PresentedSheet: Equatable {
    /// Settings, from the list's gear button.
    case settings
    /// Sync, from the list's cloud button.
    case sync
    /// Sync, from the row inside Settings — Done there returns to Settings.
    case settingsSync
    /// Feedback, pushed inside the Settings sheet — Back there returns to Settings.
    case settingsFeedback
}

/// A push inside the Settings sheet's own navigation stack.
enum SettingsRoute: Hashable {
    case feedback
}

/// The folder-browser navigation path, the sheet over it and the search query,
/// owned above `NoteListView` so a debug build's puppet listener can read and
/// drive the same state the user taps through (PuppetServer.swift).
final class AppNavigation: ObservableObject {
    @Published var path: [Route] = []
    @Published var sheet: PresentedSheet?
    /// The list's `.searchable` text; non-empty replaces the root browser with results.
    @Published var searchQuery = ""

    /// A `.sheet(isPresented:)` binding for one sheet. Dismissing the Sync sheet
    /// opened from Settings lands back on Settings, as the user's Done does.
    func isPresenting(_ presented: PresentedSheet) -> Binding<Bool> {
        Binding(
            get: { [weak self] in
                guard let sheet = self?.sheet else { return false }
                // Settings stays presented underneath its own Sync sheet and Feedback push.
                return sheet == presented
                    || (presented == .settings
                        && (sheet == .settingsSync || sheet == .settingsFeedback))
            },
            set: { [weak self] shown in
                guard let self, !shown else { return }
                self.sheet = presented == .settingsSync ? .settings : nil
            }
        )
    }

    /// The Settings sheet's own `NavigationStack(path:)`, derived from `sheet` so a
    /// Feedback push is the screen and Back pops it to Settings.
    var settingsPath: Binding<[SettingsRoute]> {
        Binding(
            get: { [weak self] in self?.sheet == .settingsFeedback ? [.feedback] : [] },
            set: { [weak self] routes in
                guard let self else { return }
                self.sheet = routes.last == .feedback ? .settingsFeedback : .settings
            }
        )
    }
}
