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

    @Test("closing editor quarantines bridge changes until delete resolves")
    func closingEditorQuarantinesBridgeChanges() {
        #expect(editorChangeDisposition(loaded: false, isClosing: false) == .ignore)
        #expect(editorChangeDisposition(loaded: true, isClosing: false) == .apply)
        #expect(editorChangeDisposition(loaded: true, isClosing: true) == .quarantine)
    }

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

    @Test("closing editor never flushes a newly dirty buffer on disappear")
    func closingEditorDoesNotFlushOnDisappear() {
        #expect(
            shouldFlushEditorOnDisappear(
                loaded: true,
                isClosing: false,
                content: "local edit",
                savedContent: "base"
            )
        )
        #expect(
            !shouldFlushEditorOnDisappear(
                loaded: true,
                isClosing: true,
                content: "late bridge edit",
                savedContent: "delete snapshot"
            )
        )
    }

    @Test("delete confirmation cover is not treated as editor navigation")
    func deleteConfirmationPreservesEditorLifecycle() {
        #expect(
            !shouldHandleEditorDisappear(isDeleteConfirmationPresented: true)
        )
        #expect(
            shouldHandleEditorDisappear(isDeleteConfirmationPresented: false)
        )
    }

    @Test("navigation commits only a loaded dirty editor")
    func navigationCommitDecision() {
        #expect(
            needsEditorCommitBeforeNavigation(
                loaded: true,
                content: "local edit",
                savedContent: "base"
            )
        )
        #expect(
            !needsEditorCommitBeforeNavigation(
                loaded: true,
                content: "same",
                savedContent: "same"
            )
        )
        #expect(
            !needsEditorCommitBeforeNavigation(
                loaded: false,
                content: "placeholder",
                savedContent: ""
            )
        )
    }

    @Test("navigation completes after any durable persist-or-park outcome")
    func navigationFlushDecision() {
        #expect(shouldCompleteEditorNavigation(.wrote))
        #expect(shouldCompleteEditorNavigation(.converged))
        #expect(
            shouldCompleteEditorNavigation(
                .parkedConflict(parkedId: "note (conflict 2026-07-23)")
            )
        )
        #expect(!shouldCompleteEditorNavigation(nil))
    }

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
