package com.futo.notes

import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.job
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class NativeMutationOutcomeTest {
    @Test
    fun `cancellation after the disk commit cannot skip shell projection`() = runBlocking {
        var isDiskCommitted = false
        var isShellProjected = false
        var hasTransactionReturned = false

        val mutation = launch {
            val callerJob = currentCoroutineContext().job
            runMutationTransaction {
                isDiskCommitted = true
                callerJob.cancel()
                isShellProjected = true
            }
            hasTransactionReturned = true
        }
        mutation.join()

        assertTrue(isDiskCommitted)
        assertTrue(isShellProjected)
        assertTrue(hasTransactionReturned)
    }

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

    // RC-71: the engine saved the draft, then relinked the note's own link. The
    // baseline is the relinked file; a baseline left at the draft made the next
    // save read the relink as a peer's edit and park a conflict copy.
    @Test
    fun `an untouched editor adopts the relinked body as content and baseline`() {
        val rebase = rebasedOnRelink(
            flushed = "back to [[Old]]",
            live = "back to [[Old]]",
            relinkedBody = "back to [[New]]",
        )

        assertEquals(RelinkRebase("back to [[New]]", "back to [[New]]", adoptIntoEditor = true), rebase)
        assertNull(derivePendingDraft(true, "New", rebase.savedContent, rebase.content))
    }

    @Test
    fun `a draft typed during the commit is kept over the relinked baseline`() {
        val rebase = rebasedOnRelink(
            flushed = "back to [[Old]]",
            live = "back to [[Old]] more",
            relinkedBody = "back to [[New]]",
        )

        assertEquals("back to [[New]]", rebase.savedContent)
        assertEquals("back to [[Old]] more", rebase.content)
        assertFalse(rebase.adoptIntoEditor)
    }

    @Test
    fun `a rename that rewrote nothing leaves the baseline at the saved draft`() {
        listOf<String?>(null, "same").forEach { body ->
            assertEquals(
                RelinkRebase("same", "same", adoptIntoEditor = false),
                rebasedOnRelink(flushed = "same", live = "same", relinkedBody = body),
            )
        }
    }
}
