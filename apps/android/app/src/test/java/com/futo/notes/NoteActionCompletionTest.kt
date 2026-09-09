package com.futo.notes

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NoteActionCompletionTest {
    @Test
    fun `failed mutation does not complete its user action`() {
        assertFalse(shouldCompleteNoteAction(NoteMutationOutcome.Failed))
    }

    /** github#13: note creation used to answer `String?`, so a failure was
     *  indistinguishable from "nothing happened" at the call site. An outcome
     *  makes the failure a value the FAB must handle — and carries the created
     *  id on success, which is what the editor opens. */
    @Test
    fun `committed mutation completes its user action`() {
        assertTrue(shouldCompleteNoteAction(NoteMutationOutcome.Committed("moved note")))
    }
}
