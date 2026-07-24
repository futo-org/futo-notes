package com.futo.notes

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

class NativeMutationOutcomeTest {
    @Test
    fun `failed write keeps the last confirmed content and leaves a pending draft`() {
        val savedContent = confirmedSavedContent(
            previousSavedContent = "base",
            writtenContent = "local edit",
            outcome = NoteMutationOutcome.Failed,
        )

        assertEquals("base", savedContent)
        assertNotNull(derivePendingDraft(true, "Note", savedContent, "local edit"))
    }

    @Test
    fun `committed write advances only to the written snapshot`() {
        val savedContent = confirmedSavedContent(
            previousSavedContent = "base",
            writtenContent = "written snapshot",
            outcome = NoteMutationOutcome.Committed(Unit),
        )

        assertEquals("written snapshot", savedContent)
        assertNotNull(derivePendingDraft(true, "Note", savedContent, "newer edit"))
    }

    @Test
    fun `delete stops when its dirty draft write fails`() {
        assertFalse(
            shouldContinueDeleteAfterEditorWrite(
                hasPendingChanges = true,
                outcome = NoteMutationOutcome.Failed,
            ),
        )
    }

    @Test
    fun `delete continues for a clean or successfully written draft`() {
        assertTrue(
            shouldContinueDeleteAfterEditorWrite(
                hasPendingChanges = false,
                outcome = null,
            ),
        )
        assertTrue(
            shouldContinueDeleteAfterEditorWrite(
                hasPendingChanges = true,
                outcome = NoteMutationOutcome.Committed(Unit),
            ),
        )
    }
}
