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
            outcome: NoteMutationOutcome<String>.failed
        )

        #expect(result.id == "Folder/Old title")
        #expect(!result.isCommitted)
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

    // The capture/quarantine decision and the change disposition are now cases
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

    @Test("navigation capture waits for admitted editor completions")
    @MainActor
    func navigationWaitsForEditorCompletions() async {
        let queue = EditorCompletionQueue()
        var events: [String] = []

        queue.enqueue {
            events.append("save")
            queue.enqueue {
                events.append("insert")
            }
        }
        await queue.waitForCurrent()
        events.append("capture")

        #expect(events == ["save", "insert", "capture"])
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
