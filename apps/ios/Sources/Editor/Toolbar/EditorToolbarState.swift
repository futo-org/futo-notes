import SwiftUI

/// Reactive inputs the native markdown toolbar renders from. Owned by
/// EditorHost, which updates it from bridge messages (`cursorContext`).
@MainActor
final class EditorToolbarState: ObservableObject {
    /// Cursor is on a list line specifically. `inContainer` is what actually
    /// gates the Indent/Outdent items now; this stays only as the fallback
    /// for a bundle old enough to have never sent `inContainer` at all.
    @Published var onListLine = false
    /// Cursor is in a list item OR a blockquote (bridge `cursorContext.
    /// inContainer`) — shows the Indent/Outdent items. `nil` means the
    /// message hasn't carried this field at all (an older bundle); the
    /// toolbar then falls back to `onListLine`, exactly today's behavior for
    /// that bundle.
    @Published var inContainer: Bool?
    /// Toolbar-manifest ids active at the cursor/selection (bridge
    /// `formatState`, Milkdown editor) — drives the Notion-style highlighted
    /// button state below. Android's
    /// counterpart is `EditorHost.activeFormats` (EditorWebView.kt).
    @Published var activeFormats: Set<String> = []
    /// Toolbar-manifest ids that are currently INERT (bridge
    /// `formatState.disabled`, Milkdown editor) — today only `undo`/`redo`
    /// with an empty prosemirror-history stack. Dims the button and blocks
    /// the tap below. Android's counterpart is `EditorHost.disabledFormats`.
    @Published var disabledFormats: Set<String> = []
}

@MainActor
final class EditorToolbarLocalization: ObservableObject {
    @Published var localization: Localization

    init(_ localization: Localization) {
        self.localization = localization
    }

    func update(_ localization: Localization) {
        guard self.localization !== localization else { return }
        self.localization = localization
    }
}
