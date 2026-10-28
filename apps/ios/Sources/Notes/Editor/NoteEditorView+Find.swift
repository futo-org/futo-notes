import SwiftUI

extension NoteEditorView {
    /// Publish the strip of the editor viewport the find bar covers: everything
    /// from the bar's top edge down to the WebView's bottom edge (the bar sits
    /// above the home-indicator inset the WebView also extends into). Only while
    /// the bar is up, and only when the measurement actually moved — the engine
    /// latches the value, so this is one call per presentation or resize.
    func publishFindOverlayInset() {
        guard findVisible else { return }
        let inset = max(0, editorBottomGlobalY - findBarTopGlobalY)
        guard abs(inset - findOverlayInset) >= 0.5 else { return }
        findOverlayInset = inset
        EditorHost.shared.setFindOverlayInset(inset)
    }

    func openFind() {
        findVisible = true
        // Re-measure for this presentation: the bar has not been
        // laid out yet, so the inset arrives a frame later and
        // the engine re-reveals the current match against it.
        findOverlayInset = 0
        EditorHost.shared.openFind()
    }

    func closeFind() {
        findVisible = false
        if let editorAttachment,
            EditorHost.shared.isCurrentAttachment(editorAttachment)
        {
            EditorHost.shared.closeFind()
        }
    }

    /// The close control belongs to the visible editor, so it must always close
    /// that editor's find engine. Lifecycle cleanup above stays token-gated: an
    /// off-screen view disappearing after a linked note adopted the shared
    /// WebView must not close find in the newer owner.
    func dismissFind() {
        findVisible = false
        EditorHost.shared.closeFind()
    }
}
