import SwiftUI

extension NoteEditorView {
    /// The editor was popped by the system Back button or the edge swipe.
    ///
    /// A native interactive pop cannot be refused once the finger starts it, so
    /// this is `requestNavigation` run after the fact: the same drain of
    /// in-flight rename/move/adopt work, the same title-then-body commit —
    /// with nothing left to veto. The pending debounced rename is canceled
    /// first so the drain reports it uncommitted and the title commits NOW
    /// rather than after its delay. The body falls back to the shell's copy
    /// when the editor cannot answer: refusing is no longer possible, and that
    /// copy is kept in step with every `change` the editor reported.
    ///
    /// The draft token stays claimed until the exit settles, so the jetsam
    /// register covers the draft throughout. Anything that did not commit
    /// takes the retained-draft flush, which stays eligible for lifecycle retry.
    func finishLeave() {
        let token = draftToken
        let departureId = noteId
        session.cancel(.rename)
        let exit = session.end(
            .navigate,
            effects: EditorExitEffects(
                awaitCurrentBody: {
                    let current = await EditorHost.shared.awaitCurrent(noteId)
                    CloseLedger.mark("bodyCurrent", note: current.canProceed ? "current" : "behind")
                    return current.latest?.content ?? content
                },
                commitBody: { flushed in
                    content = flushed
                    guard loaded, flushed != savedContent else {
                        CloseLedger.mark("bodyClean")
                        return true
                    }
                    let disposition = await store.flushDraft(
                        PendingDraft(id: noteId, base: savedContent, content: flushed),
                        ownerToken: token)
                    CloseLedger.mark(
                        "bodyCommitted", note: disposition == nil ? "failed" : "durable")
                    guard disposition != nil else { return false }
                    savedContent = flushed
                    return true
                },
                // The editor is gone, so a rename that cannot commit is
                // reported (applyRename's toast) and the body still commits
                // under the id the note kept. Refusing would skip the body.
                commitTitle: {
                    _ = await applyRename(titleField)
                    CloseLedger.mark("titleCommitted")
                    return true
                }
            )
        )
        Task { @MainActor in
            let left = await exit?.value ?? false
            CloseLedger.mark("exitSettled", note: left ? "left" : "refused")
            let destinationId = noteId
            let baseline = savedContent
            let latest = EditorHost.shared.latest(departureId)
            if !latest.canProceed {
                if loaded, content != savedContent {
                    store.publishDraft(
                        token: token,
                        PendingDraft(id: destinationId, base: baseline, content: content))
                    store.retainDraftUntilFlushed(token: token)
                }
                EditorHost.shared.retainUnflushed(departureId) { text in
                    store.flushRetainedEditor(
                        PendingDraft(id: destinationId, base: savedContent, content: text),
                        ownerToken: token)
                }
            } else if let text = latest.latest?.content, text != baseline {
                store.flushRetainedEditor(
                    PendingDraft(id: destinationId, base: baseline, content: text),
                    ownerToken: token)
            } else if !left, loaded, content != savedContent {
                store.flushRetainedEditor(
                    PendingDraft(id: noteId, base: savedContent, content: content),
                    ownerToken: token)
            } else {
                store.releaseDraftOwnership(token: token)
            }
        }
    }

    /// Bridge 'openNote': the user tapped a RESOLVED wikilink. PUSH a new editor
    /// entry so Back returns to the note you came FROM (not straight to the
    /// list). This view's onDisappear flushes any pending draft to the old id
    /// before the pushed editor's first save can fire. The editor WebView is a
    /// single shared instance (EditorHost.shared); EditorWebView re-adopts it
    /// into whichever editor is visible, so the stacked editors stay correct on
    /// Back. Skip a self-link (a wikilink to the note you're already on).
    func openLinkedNote(_ id: String) {
        guard id != noteId else { return }
        requestNavigation {
            // The user may have swiped back while the exit drained; pushing
            // now would open the link on top of the list they returned to.
            guard isVisible else { return }
            navPath.append(.note(id))
        }
    }

    /// Back and resolved-wikilink navigation are mutations of the editor
    /// session: wait for every already-admitted identity workflow, then commit
    /// the latest body snapshot. A failed commit leaves this editor visible and
    /// dirty so navigation can be retried without losing the draft.
    func requestNavigation(_ navigate: @escaping () -> Void) {
        session.end(
            .navigate,
            effects: EditorExitEffects(
                awaitCurrentBody: { await awaitBodyForExit() },
                commitBody: { flushed in
                    content = flushed
                    // Only a loaded, dirty editor has anything to persist.
                    guard loaded, flushed != savedContent else { return true }
                    let disposition = await store.flushDraft(
                        PendingDraft(id: noteId, base: savedContent, content: flushed),
                        ownerToken: draftToken)
                    // Any durable persist-or-park outcome lets navigation finish.
                    guard disposition != nil else { return false }
                    savedContent = flushed
                    return true
                },
                commitTitle: { await applyRename(titleField) },
                perform: { _ in
                    navigate()
                    return true
                },
                onFailed: { failure, _, _ in
                    switch failure {
                    case .title:
                        store.showTransient(LocalizedMessage("notes.navigation.renamePending"))
                    case .unflushed:
                        store.showTransient(LocalizedMessage("notes.navigation.unflushed"))
                    case .body:
                        store.showTransient(LocalizedMessage("notes.navigation.saveFailed"))
                    case .action:
                        break
                    }
                }
            )
        )
    }
}
