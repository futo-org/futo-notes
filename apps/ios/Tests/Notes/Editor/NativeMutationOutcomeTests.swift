import Testing

@testable import FutoNotesNative

@Suite("Native mutation outcomes")
struct NativeMutationOutcomeTests {
    @Test("a failed write stays dirty")
    func failedWriteStaysDirty() {
        let savedContent = confirmedSavedContent(
            previousSavedContent: "base",
            writtenContent: "local edit",
            outcome: NoteMutationOutcome<Void>.failed
        )

        #expect(savedContent == "base")
        #expect(
            derivePendingDraft(
                loaded: true,
                noteId: "Note",
                savedContent: savedContent,
                content: "local edit"
            ) != nil
        )
    }

    @Test("a committed write advances only to the written snapshot")
    func committedWriteAdvancesToSnapshot() {
        let savedContent = confirmedSavedContent(
            previousSavedContent: "base",
            writtenContent: "written snapshot",
            outcome: NoteMutationOutcome<Void>.committed(())
        )

        #expect(savedContent == "written snapshot")
        #expect(
            derivePendingDraft(
                loaded: true,
                noteId: "Note",
                savedContent: savedContent,
                content: "newer edit"
            ) != nil
        )
    }

    @Test("a failed rename keeps the current identity and blocks navigation")
    func failedRenameKeepsCurrentIdentity() {
        let result = resolvedRename(
            currentId: "Folder/Old title",
            outcome: NoteMutationOutcome<CommittedNote>.failed
        )

        #expect(result.id == "Folder/Old title")
        #expect(!result.isCommitted)
    }

    @Test("a committed rename hands the relinked body to the editor")
    func committedRenameCarriesRelinkedBody() {
        let result = resolvedRename(
            currentId: "Old",
            outcome: .committed(CommittedNote(id: "New", relinkedBody: "back to [[New]]"))
        )

        #expect(result.id == "New")
        #expect(result.isCommitted)
        #expect(result.relinkedBody == "back to [[New]]")
    }

    // RC-71: the engine saved the draft, then relinked the note's own link. The
    // baseline is the relinked file; a baseline left at the draft made the next
    // save read the relink as a peer's edit and park a conflict copy.
    @Test("an untouched editor adopts the relinked body as content and baseline")
    func untouchedEditorAdoptsRelinkedBody() {
        let rebase = rebasedOnRelink(
            flushed: "back to [[Old]]", live: "back to [[Old]]",
            relinkedBody: "back to [[New]]")

        #expect(
            rebase
                == RelinkRebase(
                    savedContent: "back to [[New]]", content: "back to [[New]]",
                    adoptIntoEditor: true))
        #expect(
            derivePendingDraft(
                loaded: true, noteId: "New", savedContent: rebase.savedContent,
                content: rebase.content) == nil
        )
    }

    @Test("a draft typed during the commit is kept over the relinked baseline")
    func typedDraftIsKeptOverTheRelinkedBaseline() {
        let rebase = rebasedOnRelink(
            flushed: "back to [[Old]]", live: "back to [[Old]] more",
            relinkedBody: "back to [[New]]")

        #expect(rebase.savedContent == "back to [[New]]")
        #expect(rebase.content == "back to [[Old]] more")
        #expect(!rebase.adoptIntoEditor)
    }

    @Test("a rename that rewrote nothing leaves the baseline at the saved draft")
    func plainRenameKeepsTheSavedDraftAsBaseline() {
        for body in [nil, "same"] as [String?] {
            let rebase = rebasedOnRelink(flushed: "same", live: "same", relinkedBody: body)
            #expect(
                rebase
                    == RelinkRebase(
                        savedContent: "same", content: "same", adoptIntoEditor: false))
        }
    }

    @Test("delete stops when its dirty draft write fails")
    func deleteStopsAfterFailedDraftWrite() {
        #expect(
            !shouldContinueDeleteAfterEditorWrite(
                hasPendingChanges: true,
                outcome: NoteMutationOutcome<Void>.failed
            )
        )
    }

    @Test("delete continues for a clean or successfully written draft")
    func deleteContinuesAfterDurableDraft() {
        #expect(
            shouldContinueDeleteAfterEditorWrite(
                hasPendingChanges: false,
                outcome: nil
            )
        )
        #expect(
            shouldContinueDeleteAfterEditorWrite(
                hasPendingChanges: true,
                outcome: NoteMutationOutcome<Void>.committed(())
            )
        )
    }

    // The mailbox/exit decision and the change disposition are now cases
    // of the session's one exit verb — see EditorSessionTests.

    @Test("async editor completion stays with the generation that started it")
    func editorCompletionGeneration() {
        #expect(shouldDeliverEditorCompletion(capturedGeneration: 7, currentGeneration: 7))
        #expect(!shouldDeliverEditorCompletion(capturedGeneration: 7, currentGeneration: 8))
        #expect(
            editorGenerationAfterDetach(detachedToken: 7, currentGeneration: 7) == 8
        )
        #expect(
            editorGenerationAfterDetach(detachedToken: 6, currentGeneration: 7) == 7
        )
    }

    @Test("navigation waits for admitted image insertions")
    @MainActor
    func navigationWaitsForImageInsertions() async {
        let queue = EditorCompletionQueue()
        var events: [String] = []

        queue.enqueue {
            events.append("save")
            queue.enqueue {
                events.append("insert")
            }
        }
        await queue.waitForCurrent()
        events.append("navigate")

        #expect(events == ["save", "insert", "navigate"])
    }

    // The leave-flush, delete-cover, dirty-commit, and persist-or-park-completes
    // decisions are all reachable through the session now — see
    // EditorSessionTests.

    @Test("move follows a draft parked under a conflict identity")
    func moveSourceIdentity() {
        #expect(
            editorMoveSourceId(currentId: "Folder/Note", disposition: .wrote)
                == "Folder/Note"
        )
        #expect(
            editorMoveSourceId(
                currentId: "Folder/Note",
                disposition: .parkedConflict(parkedId: "Folder/Note (conflict 2026-07-23)")
            ) == "Folder/Note (conflict 2026-07-23)"
        )
    }
}
