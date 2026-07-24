package com.futo.notes

import org.junit.Assert.assertFalse
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
}
