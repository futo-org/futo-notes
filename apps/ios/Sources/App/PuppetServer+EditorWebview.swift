#if DEBUG
    import Foundation
    import UIKit

    extension PuppetServer {
        /// The editor webview's rect on the screen; nil under a sheet or a dialog, where a
        /// touch cannot reach it, so it is not there to aim at.
        @MainActor
        func webviewOnScreen() -> CGRect? {
            let webView = EditorHost.shared.webView
            return webView.window.flatMap { window in
                PuppetScreenReader.reaches(webView)
                    ? window.convert(
                        webView.convert(webView.bounds, to: nil), to: window.screen.coordinateSpace)
                    : nil
            }
        }

        @MainActor
        func forward(_ command: String, argsJson: String) async -> PuppetReply {
            let raw: String? = await withCheckedContinuation { continuation in
                EditorHost.shared.webView.evaluateJavaScript(
                    PuppetServerContract.forwardScript(command: command, argsJson: argsJson)
                ) { value, _ in
                    continuation.resume(returning: value as? String)
                }
            }
            return PuppetServerContract.response(fromForwarded: raw)
        }

        /// The editor page's own answer to `command` while an editor is on top with no sheet
        /// of the shell's over it; nil elsewhere, or when it does not answer. The editor's own
        /// sheets and alerts still cover its text and verbs: `webviewOnScreen()` says when.
        @MainActor
        func pageObject(_ command: String) async -> [String: Any]? {
            guard navigation.sheet == nil, editorNote != nil else { return nil }
            let forwarded = await forward(command, argsJson: "{}")
            guard forwarded.status == 200 else { return nil }
            return try? JSONSerialization.jsonObject(with: forwarded.body) as? [String: Any]
        }

        /// The webview is only what the user is looking at while an editor is on top of
        /// the stack with nothing over it. Everywhere else the screen is native SwiftUI,
        /// and a page query would answer about the note the webview still holds — so it
        /// says where to look instead: `notes` for the vault, `state` for the screen.
        @MainActor
        func requirePage(for action: String) -> PuppetReply? {
            if let sheet = navigation.sheet {
                return PuppetServerContract.refusal(
                    503,
                    "\(action) reads the editor webview, and the "
                        + "\(PuppetServerContract.screen(path: [], sheet: sheet)) sheet is "
                        + "over it; GoBack first")
            }
            guard editorNote != nil else {
                return PuppetServerContract.refusal(
                    503,
                    "\(action) reads the editor webview; this screen is native. "
                        + "Use `notes` for the vault and `state` for the screen")
            }
            guard webviewOnScreen() != nil else {
                return PuppetServerContract.refusal(
                    503,
                    "\(action) reads the editor webview, and a sheet or a dialog is over it; "
                        + "answer it or GoBack first")
            }
            return nil
        }

        /// The editor on top of the stack has read its note from disk and handed it to
        /// the webview — before that, a write would be overwritten by the load (seen
        /// on 2026-09-17: a new note then `Insert` left an empty note). Waits up to
        /// three seconds; nil when the editor is loaded or no note is open.
        @MainActor
        func awaitEditorLoaded(for action: String) async -> PuppetReply? {
            guard let expected = editorNote else { return nil }
            let deadline = Date().addingTimeInterval(3)
            while EditorHost.shared.loadedNoteId != expected {
                guard Date() < deadline else {
                    return PuppetServerContract.refusal(
                        503, "\(action): the editor has not finished loading \(expected)")
                }
                try? await Task.sleep(nanoseconds: 50_000_000)
            }
            // One more turn so the SwiftUI update that pushes the body reaches the webview first.
            try? await Task.sleep(nanoseconds: 50_000_000)
            return nil
        }
    }
#endif
