package com.futo.notes

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class NoteActionCompletionTest {
    @Test
    fun `failed mutation does not complete its user action`() {
        assertFalse(shouldCompleteNoteAction(NoteMutationOutcome.Failed))
    }

    @Test
    fun `committed mutation completes its user action`() {
        assertTrue(shouldCompleteNoteAction(NoteMutationOutcome.Committed("moved note")))
    }

    /** github#13: note creation used to answer `String?`, so a failure was
     *  indistinguishable from "nothing happened" at the call site. An outcome
     *  makes the failure a value the FAB must handle — and carries the created
     *  id on success, which is what the editor opens. */
    @Test
    fun `a failed note create does not open an editor`() {
        val outcome: NoteMutationOutcome<String> = NoteMutationOutcome.Failed
        assertFalse(shouldCompleteNoteAction(outcome))
        assertNull((outcome as? NoteMutationOutcome.Committed)?.value)
    }

    @Test
    fun `a committed note create carries the final note id`() {
        val outcome: NoteMutationOutcome<String> = NoteMutationOutcome.Committed("Untitled-2")
        assertTrue(shouldCompleteNoteAction(outcome))
        assertEquals("Untitled-2", (outcome as NoteMutationOutcome.Committed).value)
    }
}
