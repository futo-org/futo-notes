import UIKit
import WebKit
import os

extension EditorHost {
    // MARK: JS bridge

    /// Host → editor: insert `![](filename)\n` only if the editor that started
    /// the asynchronous image operation still owns the shared WebView.
    @discardableResult
    func insertImage(_ filename: String, for capturedGeneration: Int) async -> Bool {
        guard
            shouldDeliverEditorCompletion(
                capturedGeneration: capturedGeneration,
                currentGeneration: generation
            )
        else { return false }
        do {
            // The editor posts its change callback on requestAnimationFrame.
            // Wait for that frame so navigation cannot rebind the shared
            // bridge while the old note's callback is still queued.
            let inserted = try await webView.callAsyncJavaScript(
                """
                if (!window.FutoEditor) return false;
                window.FutoEditor.insertImage(filename);
                await new Promise(resolve => requestAnimationFrame(resolve));
                return true;
                """,
                arguments: ["filename": filename],
                in: nil,
                contentWorld: .page
            )
            return inserted as? Bool == true
                && shouldDeliverEditorCompletion(
                    capturedGeneration: capturedGeneration,
                    currentGeneration: generation
                )
        } catch {
            return false
        }
    }

    /// Invalidate completions owned by the current editor before a committed
    /// delete exposes another note in the shared WebView.
    func invalidateAsyncCompletions() {
        generation += 1
    }

    /// Freeze user editing before a destructive native workflow. The resulting
    /// bridge callback is still guarded by the owning editor's closing latch.
    func blur() {
        webView.evaluateJavaScript(
            "window.FutoEditor && window.FutoEditor.blur();", completionHandler: nil)
    }

    /// Run a shared toolbar command from the generated toolbar manifest.
    func exec(_ commandId: String) {
        webView.evaluateJavaScript(
            "window.FutoEditor && window.FutoEditor.exec(\(jsLiteral(commandId)));",
            completionHandler: nil)
    }

    func openFind() {
        webView.evaluateJavaScript(
            "window.FutoEditor && window.FutoEditor.openFind();", completionHandler: nil)
    }

    /// Report how much of the editor viewport the shell's own chrome covers, so
    /// find reveals the current match above it. The find bar is a
    /// `.safeAreaInset` over a WebView that ignores the container's bottom safe
    /// area, so without this a match stepped to from above lands underneath the
    /// bar (docs/spec/editor.md: the current match is always visible).
    func setFindOverlayInset(_ bottomOverlayPx: CGFloat) {
        let px = Int(max(0, bottomOverlayPx).rounded())
        webView.evaluateJavaScript(
            "window.FutoEditor && window.FutoEditor.setFindOverlayInset(\(px));",
            completionHandler: nil)
    }

    func setFindQuery(_ query: String) {
        webView.evaluateJavaScript(
            "window.FutoEditor && window.FutoEditor.setFindQuery(\(jsLiteral(query)));",
            completionHandler: nil)
    }

    func stepFind(_ delta: Int) {
        guard delta == -1 || delta == 1 else { return }
        webView.evaluateJavaScript(
            "window.FutoEditor && window.FutoEditor.stepFind(\(delta));", completionHandler: nil)
    }

    func closeFind() {
        webView.evaluateJavaScript(
            "window.FutoEditor && window.FutoEditor.closeFind();", completionHandler: nil)
    }

    /// Called when an editor screen enters the window.
    func runPendingAutoFocus() {
        if pendingAutoFocus { startAutoFocus() }
    }

    /// Return in the title field: carry the typing on into the body.
    func focusBody() {
        startAutoFocus()
    }

    /// Brand-new note: focus the editor and raise the keyboard. Flip the global
    /// "force keyboard" gate ON only for this programmatic focus, then back OFF,
    /// so opening an EXISTING note never pops the keyboard.
    func startAutoFocus() {
        // A brand-new note attaches while its screen is still being built, so
        // the web view is not in a window yet and cannot take first responder:
        // the focus lands in the page with no keyboard. Wait for the window.
        guard webView.window != nil else {
            pendingAutoFocus = true
            return
        }
        pendingAutoFocus = false
        futoForceKeyboardOnFocus = true
        // Take first responder natively before the script focuses. From iOS 27
        // WebKit does not report a script focus to the app at all while the
        // web view is not first responder (the page is unfocused), so the
        // focus swizzle below never ran and no keyboard came up — on a new note
        // and on Return in the title, which has just resigned first responder.
        webView.becomeFirstResponder()
        // Blur first: a page that still holds DOM focus from an earlier note
        // makes `focus()` a no-op, and WebKit only raises the keyboard on a
        // focus CHANGE. The gate closes once the script has run, not on a
        // timer — a web process busy loading the note ran the focus after a
        // fixed 0.6s window had shut, leaving a focused page with no keyboard.
        webView.evaluateJavaScript(
            """
            if (window.FutoEditor) {
              if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
              window.FutoEditor.focus();
            }
            """
        ) { _, _ in
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                futoForceKeyboardOnFocus = false
            }
        }
    }

    /// Encode an arbitrary Swift string as a safe JS string literal.
    func jsLiteral(_ s: String) -> String {
        let data =
            (try? JSONSerialization.data(withJSONObject: [s], options: []))
            ?? Data("[\"\"]".utf8)
        var json = String(data: data, encoding: .utf8) ?? "[\"\"]"
        // Strip the surrounding [ ] to get just the quoted string literal.
        json = json.trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        return json
    }

    func pushContent(_ content: String) {
        lastPushedContent = content
        lastPushedNoteId = desiredNoteId
        pushed[desiredNoteId] = content
        let js =
            "window.FutoEditor && window.FutoEditor.setContent(\(jsLiteral(desiredNoteId)), \(jsLiteral(content)));"
        webView.evaluateJavaScript(js, completionHandler: nil)
    }

    func pushTheme(_ theme: String) {
        currentTheme = theme
        let js = "window.FutoEditor && window.FutoEditor.setTheme(\(jsLiteral(theme)));"
        webView.evaluateJavaScript(js, completionHandler: nil)
    }

    func pushLanguage(_ languageTag: String) {
        currentLanguageTag = languageTag
        let js =
            "window.FutoEditor && window.FutoEditor.setLanguage && "
            + "window.FutoEditor.setLanguage(\(jsLiteral(languageTag)));"
        webView.evaluateJavaScript(js, completionHandler: nil)
    }

    func pushNotes(_ json: String) {
        lastPushedNotesJson = json
        let js = "window.FutoEditor && window.FutoEditor.setNotes(\(jsLiteral(json)));"
        webView.evaluateJavaScript(js, completionHandler: nil)
    }

    /// Everything this shell wants the freshly-loaded page to be, sent once per
    /// page load in reply to `ready`. The bundle applies it in its own order
    /// and answers with `initialized` (packages/editor/src/hostBoot.ts), so a
    /// WebContent reload restores the open note by re-sending this and nothing
    /// else.
    ///
    /// Auto-focus is deliberately NOT in here: raising the keyboard needs the
    /// swizzled WKContentView focus method, which only this shell has.
    func sendHostConfig() {
        var config: [String: Any] = [
            "bridgeVersion": BridgeSpec.version,
            "theme": desiredTheme,
            "languageTag": desiredLanguageTag,
            "noteId": desiredNoteId,
            "content": desiredContent,
            // The markdown toolbar is a native keyboard accessory here, so the
            // embed must keep its own web toolbar hidden.
            "nativeToolbar": true,
            // Aligns the note body's left edge with the inline title field
            // (NoteEditorView's TitleTextField, 20pt); the embed's `.cm-line`
            // contributes the remaining 6px.
            "contentPaddingInlinePx": EditorHost.contentPaddingInlinePx,
            // Local image filenames in ![](f) resolve through the native
            // futo-asset scheme, served from the vault root.
            "imageBaseUrl": "\(FutoAssetSchemeHandler.scheme):///",
        ]
        if let json = desiredNotesJson { config["notesJson"] = json }

        guard let data = try? JSONSerialization.data(withJSONObject: config),
            let json = String(data: data, encoding: .utf8)
        else {
            EditorHost.logger.error("could not serialize the editor host config")
            return
        }
        // Record what the config carries, so the catch-up on `initialized`
        // re-pushes only what actually moved while it was in flight.
        currentTheme = desiredTheme
        currentLanguageTag = desiredLanguageTag
        lastPushedContent = desiredContent
        lastPushedNoteId = desiredNoteId
        pushed[desiredNoteId] = desiredContent
        lastPushedNotesJson = desiredNotesJson

        webView.evaluateJavaScript(
            "window.FutoEditor && window.FutoEditor.initialize(\(jsLiteral(json)));"
        ) { _, error in
            // The bundle throws on a config it cannot read. Without this the
            // failure mode is a silently unconfigured editor.
            if let error {
                EditorHost.logger.error(
                    "FutoEditor.initialize failed: \(error.localizedDescription, privacy: .public)")
            }
        }
    }
}
