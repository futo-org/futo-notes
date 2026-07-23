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

    @Test("closing editor rejects bridge changes")
    func closingEditorRejectsBridgeChanges() {
        #expect(shouldAcceptEditorChange(loaded: true, isClosing: false))
        #expect(!shouldAcceptEditorChange(loaded: true, isClosing: true))
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
}
