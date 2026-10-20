import SwiftUI

func editorMoveSourceId(currentId: String, disposition: FlushDisposition) -> String {
    switch disposition {
    case .parkedConflict(let parkedId):
        return parkedId
    case .wrote, .converged, .recreated:
        return currentId
    }
}

extension NoteEditorView {
    /// The open note's list item — for the move sheet. Falls back to a synthetic
    /// item when the store is mid-reload (the sheet only needs id/title/folder).
    var currentItem: NoteItem {
        if let item = store.notes.first(where: { $0.id == noteId }) { return item }
        let parts = splitId(id: noteId)
        return NoteItem(
            id: noteId, title: parts.title, folder: parts.folder,
            modified: Date(), richPreview: "", tags: [])
    }

    /// Nav-bar "Move to Folder…": wait for already-admitted identity work before
    /// presenting destinations. The final live body is captured and committed
    /// only after the user chooses a destination in [moveNote].
    func prepareMove() {
        session.end(
            .prepareMove,
            effects: EditorExitEffects(
                perform: { _ in
                    showMove = true
                    return true
                }
            )
        )
    }

    /// The move sheet hands the destination back synchronously so this editor
    /// owns the complete capture, persist-or-park, and move transaction. Delete
    /// can then cancel/await that exact task and, if the move already committed,
    /// target its final id.
    func moveNote(to folder: String) {
        session.end(
            .move,
            effects: EditorExitEffects(
                awaitCurrentBody: { await awaitBodyForExit() },
                commitBody: { flushed in
                    content = flushed
                    return true
                },
                perform: { _ in
                    let flushed = content
                    switch await store.moveNote(
                        noteId, toFolder: folder,
                        draft: PendingDraft(id: noteId, base: savedContent, content: flushed),
                        ownerToken: draftToken)
                    {
                    case .committed(let committed):
                        // Apply even if a delete latched the session closed while
                        // the actor call was in flight. Delete awaits this task
                        // and must see the committed id.
                        savedContent = flushed
                        await retargetNoteId(committed.id)
                        titleField = splitId(id: committed.id).title
                        await settleRelink(flushed: flushed, relinkedBody: committed.relinkedBody)
                        return true
                    case .failed:
                        return false
                    }
                },
                onFailed: { failure, _, _ in
                    switch failure {
                    case .unflushed:
                        store.showTransient(LocalizedMessage("notes.navigation.unflushed"))
                    case .body:
                        store.showTransient(LocalizedMessage("notes.move.saveFailed"))
                    case .action:
                        if !session.isClosing {
                            store.showTransient(LocalizedMessage("notes.errors.moveFailed"))
                        }
                    case .title:
                        break
                    }
                }
            )
        )
    }

    /// Confirmed delete from the nav-bar menu: neutralize every pending-save
    /// path FIRST (a write after the delete would resurrect the file — the Rust
    /// write creates files unconditionally), then delete and pop the editor.
    func deleteNote() {
        session.end(
            .delete,
            effects: EditorExitEffects(
                // The session has already cancelled every workflow and latched
                // closed, so a bridge change arriving from here on is
                // quarantined rather than applied.
                prepare: { EditorHost.shared.blur() },
                awaitCurrentBody: { await awaitBodyForExit() },
                commitBody: { body in
                    let hasPendingChanges = body != savedContent
                    let writeOutcome =
                        hasPendingChanges
                        ? await store.write(noteId, content: body, ownerToken: draftToken)
                        : nil
                    if let writeOutcome {
                        savedContent = confirmedSavedContent(
                            previousSavedContent: savedContent,
                            writtenContent: body,
                            outcome: writeOutcome
                        )
                    }
                    return shouldContinueDeleteAfterEditorWrite(
                        hasPendingChanges: hasPendingChanges,
                        outcome: writeOutcome
                    )
                },
                perform: { committedBody in
                    content = committedBody ?? content
                    savedContent = content
                    // Clear the draft register only after every dirty snapshot
                    // commits. A retained draft cannot then recreate the note.
                    publishDraft()
                    let outcome = await store.delete(noteId, ownerToken: draftToken)
                    if case .committed = outcome { return true }
                    return false
                },
                onSucceeded: {
                    EditorHost.shared.invalidateAsyncCompletions()
                    presentWithoutAnimation { showDeleteConfirm = false }
                    if !navPath.isEmpty { navPath.removeLast() }
                },
                onFailed: { failure, lateContent, attemptedBody in
                    switch failure {
                    case .unflushed:
                        content = lateContent ?? content
                        presentWithoutAnimation { showDeleteConfirm = false }
                        publishDraft()
                        if content != savedContent { scheduleSave(content) }
                        store.showTransient(LocalizedMessage("notes.navigation.unflushed"))
                    case .body:
                        content = lateContent ?? attemptedBody ?? content
                        presentWithoutAnimation { showDeleteConfirm = false }
                        publishDraft()
                        scheduleSave(content)
                        store.showTransient(LocalizedMessage("notes.delete.savePending"))
                    case .action:
                        if let lateContent {
                            content = lateContent
                            scheduleSave(lateContent)
                        }
                        presentWithoutAnimation { showDeleteConfirm = false }
                        publishDraft()
                        store.showTransient(LocalizedMessage("notes.errors.deleteFailed"))
                    case .title:
                        break
                    }
                }
            )
        )
    }
}
