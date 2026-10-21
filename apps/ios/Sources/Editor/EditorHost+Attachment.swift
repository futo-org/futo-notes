import UIKit
import WebKit

extension EditorHost {
    /// Bind a note's callbacks. Returns a token for the matching [detach]. If the
    /// editor is already warm, push the desired content/theme (and focus) now so
    /// the "ready for this note" contract holds for reused opens.
    func attach(
        noteId: String,
        autoFocus: Bool,
        onChange: @escaping (String) -> Void,
        onDocumentLoaded: @escaping (String) -> Void = { _ in },
        onFocusChange: @escaping (Bool) -> Void,
        onOpenNote: ((String) -> Void)? = nil,
        onFindMatches: ((FindMatchesReport) -> Void)? = nil
    ) -> Int {
        self.onDocumentLoaded = onDocumentLoaded
        self.onFocusChange = onFocusChange
        self.onOpenNote = onOpenNote
        self.onFindMatches = onFindMatches
        self.autoFocus = autoFocus
        // A reused (already-ready) WebView still holds the PREVIOUS note's text;
        // force a fresh push by clearing the dedup marker so the new note's
        // content always lands even if the host was last showing it.
        lastPushedContent = nil
        if isReady {
            pushLanguage(desiredLanguageTag)
            pushTheme(desiredTheme)
            pushContent(desiredContent)
            if autoFocus { startAutoFocus() }
        }
        generation += 1
        mailbox.bind(generation, id: noteId, change: onChange)
        return generation
    }

    /// Unbind, unless a newer [attach] has already taken over.
    func detach(_ token: Int) {
        mailbox.detach(token)
        pruneDocumentReports()
        let nextGeneration = editorGenerationAfterDetach(
            detachedToken: token,
            currentGeneration: generation
        )
        guard nextGeneration != generation else { return }
        generation = nextGeneration
        onFocusChange = { _ in }
        onDocumentLoaded = { _ in }
        onOpenNote = nil
        onFindMatches = nil
        autoFocus = false
        pendingAutoFocus = false
    }

    func rebind(
        _ token: Int, noteId: String, onChange: @escaping (String) -> Void,
        onDocumentLoaded: @escaping (String) -> Void
    ) {
        if isCurrentAttachment(token) { self.onDocumentLoaded = onDocumentLoaded }
        if mailbox.isBound(token) { mailbox.bind(token, id: noteId, change: onChange) }
    }

    func isCurrentAttachment(_ token: Int) -> Bool {
        token == generation
    }

    func pruneDocumentReports() {
        mailbox.prune(keeping: desiredNoteId)
        for id in Array(pushed.keys) where id != desiredNoteId && mailbox.current(id).canProceed {
            pushed.removeValue(forKey: id)
        }
    }

    func retainUnflushed(_ noteId: String, deliver: @escaping (String) -> Void) {
        mailbox.retainUnflushed(noteId, deliver: deliver)
    }

    func prepareLoad(_ noteId: String) { mailbox.prepareLoad(noteId) }

    /// Relabel the open note without pushing this shell's copy, which can lag a
    /// keystroke typed after the flush: the bundle reports its live document as
    /// `toId` through `change`.
    func retarget(from fromId: String, to toId: String) {
        mailbox.retarget(fromId, to: toId)
        guard desiredNoteId == fromId else { return }
        desiredNoteId = toId
        if let text = pushed[fromId] { pushed[toId] = text }
        guard isReady, lastPushedNoteId == fromId else { return }
        lastPushedNoteId = toId
        webView.evaluateJavaScript(
            "window.FutoEditor && window.FutoEditor.retarget(\(jsLiteral(fromId)), \(jsLiteral(toId)));",
            completionHandler: nil)
    }

    func latest(_ noteId: String) -> EditorCurrent { mailbox.current(noteId) }

    func awaitLoaded(_ noteId: String, content: String) async -> EditorCurrent {
        await mailbox.awaitLoaded(noteId) {
            desiredNoteId = noteId
            desiredContent = content
            if isReady { pushContent(content) }
        }
    }

    func awaitCurrent(_ noteId: String, deadline: TimeInterval = 6) async -> EditorCurrent {
        await mailbox.awaitCurrent(noteId, deadline: deadline) { token in
            webView.evaluateJavaScript(
                "window.FutoEditor && window.FutoEditor.flush(\(jsLiteral(token)));",
                completionHandler: nil)
        }
    }

    func applyExternal(noteId: String, content: String, expectedGeneration: Int) async -> Bool {
        guard isReady, noteId == desiredNoteId, adoptions[noteId] == nil else { return false }
        externalPushed[noteId] = content
        let applied = await awaitEditorSignal { answer in
            adoptions[noteId] = answer
            webView.evaluateJavaScript(
                "window.FutoEditor && window.FutoEditor.applyExternalContent(\(jsLiteral(noteId)), \(jsLiteral(content)), \(expectedGeneration));",
                completionHandler: nil)
        }
        adoptions.removeValue(forKey: noteId)
        externalPushed.removeValue(forKey: noteId)
        if applied {
            desiredContent = content
            lastPushedContent = content
        }
        return applied
    }

    func updateDesired(noteId: String, content: String, theme: String, localization: Localization) {
        desiredNoteId = noteId
        desiredContent = content
        desiredTheme = theme
        desiredLocalization = localization
        toolbarAccessory.updateLocalization(localization)
        let languageTag = localization.effectiveLanguage.tag
        guard isReady else { return }
        if languageTag != currentLanguageTag { pushLanguage(languageTag) }
        if theme != currentTheme { pushTheme(theme) }
        if noteId != lastPushedNoteId || content != lastPushedContent { pushContent(content) }
    }

    func setLocalization(_ localization: Localization) {
        desiredLocalization = localization
        toolbarAccessory.updateLocalization(localization)
        let languageTag = localization.effectiveLanguage.tag
        if editorFileURL == nil {
            loadEditor()
            return
        }
        guard isReady, languageTag != currentLanguageTag else { return }
        pushLanguage(languageTag)
    }

    /// Host → editor: the note universe ([{id,title,modifiedMs,tags}] JSON) for
    /// suffix-resolution, wikilink autocomplete, and decoration refresh. Deduped
    /// on the JSON string so repeated `$notes` publishes don't spam
    /// evaluateJavaScript; the page persists across note-opens, so the universe
    /// only needs re-pushing when it actually changes (or after a fresh ready).
    func setNotes(_ json: String) {
        desiredNotesJson = json
        guard isReady, json != lastPushedNotesJson else { return }
        pushNotes(json)
    }
}
