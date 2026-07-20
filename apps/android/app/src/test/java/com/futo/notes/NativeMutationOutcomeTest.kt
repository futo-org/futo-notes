package com.futo.notes

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
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
}
