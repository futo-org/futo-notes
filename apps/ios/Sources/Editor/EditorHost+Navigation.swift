import UIKit
import WebKit
import os

extension EditorHost {
    // MARK: WKNavigationDelegate

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        let isMainFrame = navigationAction.targetFrame?.isMainFrame ?? true
        switch editorNavigationDecision(
            for: navigationAction.request.url,
            isMainFrame: isMainFrame,
            permittedFileURL: editorFileURL
        ) {
        case .allow:
            decisionHandler(.allow)
        case .openExternally(let url):
            openEditorURLExternally(url)
            decisionHandler(.cancel)
        case .deny:
            decisionHandler(.cancel)
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        // Replace the keyboard's default prev/next/Done accessory bar with the
        // native markdown toolbar. The WKContentView is in the scroll view by
        // now.
        webView.futo_overrideInputAccessoryView(toolbarAccessory)
    }

    /// The WebKit content process died (OOM / jetsam under memory pressure).
    /// The editor — the app's core surface — is now blank with no automatic
    /// recovery. Reload it: the fresh page's `ready` gets the same host config
    /// (built from the retained `desired*` state), which restores the open note
    /// without the user noticing more than a brief flash. Without this handler
    /// the editor stays permanently blank after a backgrounded jetsam.
    ///
    /// Nothing but readiness needs resetting — the config is applied
    /// unconditionally, so the dedupe markers `sendHostConfig` sets are correct
    /// for the fresh page too.
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        EditorHost.logger.error("WebContent process terminated; reloading editor")
        isReady = false
        // The lost renderer cannot deliver its unreported edit. Wake its waiters.
        mailbox.rendererGone()
        for answer in Array(adoptions.values) { answer(false) }
        loadEditor()
    }
}
