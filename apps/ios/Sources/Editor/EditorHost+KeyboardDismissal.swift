import UIKit
import WebKit

extension EditorHost {
    /// Ends the page's editing session when the keyboard leaves the web
    /// content but the editor is still the page's `activeElement` — no
    /// keyboard, yet an editor that reads as focused, so a long press kept
    /// selecting text instead of lifting a block.
    ///
    /// - A native field (find, title) taking the keyboard over posts
    ///   `keyboardDidShow`: a DOM blur only. Find has already selected its
    ///   match in the editor, and the bridge `blur()` would collapse it, so the
    ///   next Previous re-selected it and stayed put.
    /// - The hide key on an iPad's keyboard posts `keyboardDidHide`: the bridge
    ///   `blur()`, as the toolbar chevron does — a bare DOM blur left the table
    ///   grips on screen. Only while the editor still holds page focus, so a
    ///   hide after a handover (find's Search key) keeps find's match.
    ///
    /// A keyboard that hides while the web content KEEPS first responder — a
    /// share sheet over it — comes back on its own and is left alone.
    /// Measured on the iPad (A16) and iPhone simulators, iOS 27.0.
    func observeKeyboardDismissal() {
        whileWebContentLacksKeyboard(
            UIResponder.keyboardDidShowNotification,
            run: "document.querySelector('.ProseMirror')?.blur();")
        // One script, so the focus it checks is the focus it ends.
        whileWebContentLacksKeyboard(
            UIResponder.keyboardDidHideNotification,
            run: """
                if (window.FutoEditor && document.activeElement?.classList.contains('ProseMirror'))
                  window.FutoEditor.blur();
                """)
    }

    /// Runs `script` on every `notification` posted while the web content is
    /// not first responder.
    private func whileWebContentLacksKeyboard(
        _ notification: Notification.Name, run script: String
    ) {
        NotificationCenter.default.addObserver(forName: notification, object: nil, queue: .main) {
            [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, self.webView.futo_contentView?.isFirstResponder == false else {
                    return
                }
                self.webView.evaluateJavaScript(script, completionHandler: nil)
            }
        }
    }
}
