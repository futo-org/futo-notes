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

}
