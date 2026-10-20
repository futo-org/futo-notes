import SwiftUI

extension NoteEditorView {
    /// Posted changes and mailbox snapshots take the same persistence path.
    func receiveEditorChange(_ newContent: String) {
        // Data-loss guard: ignore editor change events until the off-main
        // initial read has landed (`loaded`). The reused WebView mounts
        // with the new note's content via setContent and can emit an echo
        // before the disk read returns; saving that echo could clobber the
        // note on disk. Once loaded, all edits flow through.
        switch session.disposition(loaded: loaded) {
        case .ignore:
            return
        case .quarantine:
            session.quarantine(newContent)
            return
        case .apply:
            break
        }
        editVersion &+= 1
        content = newContent
        // Publish the derived draft SYNCHRONOUSLY here, not only via the
        // async `.onChange(of: draftInputs)` below. The scenePhase
        // background handler reads the register synchronously on
        // `.inactive`; SwiftUI may not have run the `.onChange` publish
        // yet in the same update pass, so an edit-then-immediate-
        // background could leave the register stale and lose the newest
        // keystroke to jetsam (N1 — this restores the pre-refactor
        // synchronous publish). publishDraft runs the same derivation, so
        // a clean buffer still publishes nil (no R1 regression); the
        // derived `.onChange` still owns clear-on-save/clear-on-adopt.
        // F8 jetsam guard.
        publishDraft()
        scheduleSave(newContent)
    }

    func flushEditorMailbox() async {
        guard loaded, !session.isClosing else { return }
        let current = await EditorHost.shared.awaitCurrent(noteId)
        if let live = current.latest?.content, live != content { receiveEditorChange(live) }
        await session.cancelAndDrain(.save)
        publishDraft()
        if content != savedContent {
            let snapshot = content
            _ = await session.schedule(.save) { await persistBody(snapshot) }.value
        }
        publishDraft()
        if content != savedContent { scheduleSave(content) }
    }

    /// Supply the reconciler with live editor state and the synchronous effects
    /// that render Rust's exhaustive disposition. No conflict policy lives in
    /// this view.
    private func openNoteEffects() -> OpenNoteReconcileEffects {
        OpenNoteReconcileEffects(
            snapshot: {
                guard documentReady, !session.isClosing else { return nil }
                return OpenNoteEditorSnapshot(
                    id: noteId,
                    base: savedContent,
                    draft: content,
                    isFocused: editorFocused,
                    isVisible: isVisible,
                    editVersion: editVersion
                )
            },
            awaitCurrent: {
                let current = await EditorHost.shared.awaitCurrent(noteId)
                if let live = current.latest?.content, live != content { receiveEditorChange(live) }
                return current
            },
            cancelAndDrainSave: {
                await session.cancelAndDrain(.save)
            },
            readDisk: { id in
                try await store.readIfExists(id)
            },
            resumeDraftSave: {
                if content != savedContent { scheduleSave(content) }
            },
            followRename: { toId in
                await retargetNoteId(toId)
                titleField = splitId(id: toId).title
            },
            adopt: { disk in
                guard let generation = EditorHost.shared.latest(noteId).latest?.generation,
                    await EditorHost.shared.applyExternal(
                        noteId: noteId, content: disk, expectedGeneration: generation)
                else { return false }
                content = disk
                savedContent = disk
                return true
            },
            keepDraft: { base, reason in
                savedContent = base
                switch reason {
                case .peerDeleted:
                    store.showTransient(LocalizedMessage("notes.save.openNoteDeletedKeepingDraft"))
                case .diverged:
                    store.showTransient(LocalizedMessage("notes.save.localEditsKept"))
                case .converged:
                    break
                }
                if content != savedContent { scheduleSave(content) }
            },
            close: {
                session.closeForExternalDelete()
                savedContent = content
                store.showTransient(LocalizedMessage("notes.deletedElsewhere"))
                if !navPath.isEmpty { navPath.removeLast() }
            }
        )
    }

    /// The freshest body for an exit — or nil, which REFUSES the exit.
    ///
    /// One helper for all three exits, because "what does it mean that the
    /// editor did not answer?" is one question and not three. The answer that
    /// matters is that an editor which never presented a document holds nothing:
    /// this view's own `content` (read from disk, then kept in step with every
    /// `change` the editor reported) is then the freshest body there is, so
    /// leaving proceeds — and `commitBody`'s `!= savedContent` guard makes it a
    /// no-op when the note was never edited, which ABANDONS the load rather
    /// than saving a prefix.
    ///
    /// A behind mailbox that cannot flush refuses a user exit; renderer death
    /// permits proceeding with the newest received bytes.
    func awaitBodyForExit() async -> String? {
        let current = await EditorHost.shared.awaitCurrent(noteId)
        return current.canProceed ? (current.latest?.content ?? content) : nil
    }

    /// Push the note universe ([{id,title,modifiedMs,tags}] JSON) into the
    /// embed for suffix resolution, autocomplete, and wikilink decoration. The
    /// built JSON doubles as the dedupe signature — EditorHost skips the
    /// evaluateJavaScript when it matches the last push.
    func pushNotesUniverse() {
        let items: [[String: Any]] = store.notes.map { note in
            [
                "id": note.id,
                "title": note.title,
                "modifiedMs": Int64(note.modified.timeIntervalSince1970 * 1000),
                "tags": note.tags,
            ]
        }
        let data =
            (try? JSONSerialization.data(withJSONObject: items, options: [.sortedKeys]))
            ?? Data("[]".utf8)
        EditorHost.shared.setNotes(String(data: data, encoding: .utf8) ?? "[]")
    }

    /// Coalesce external-change signals into the editor session's adoption
    /// workflow. A stale pass retries with fresh facts; every individual pass
    /// still performs exactly one post-read identity/visibility validation.
    func scheduleOpenNoteReconciliation(_ change: OpenNoteChange) {
        guard !session.isClosing else { return }
        let effects = openNoteEffects()
        session.schedule(.adopt) {
            for _ in 0..<3 {
                let result = await openNoteReconciler.reconcile(
                    change: change,
                    effects: effects
                )
                if result != .stale { break }
            }
            return true
        }
    }
}
