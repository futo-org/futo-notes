package com.futo.notes

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * F8: `NotesStore.saveImageIntoVault` used to catch `Exception` around the
 * whole save — which also catches `CancellationException` — and, when
 * `useSavedImage` failed (a timed-out or unavailable WebView insertion, F3),
 * left the just-written image file behind in the vault with nothing pointing
 * at it. [deleteImageOnFailure] is the extracted cleanup rule, plain JVM
 * testable without `NotesStore`'s FFI-backed `core`.
 */
class DeleteImageOnFailureTest {
    @get:Rule val tmp = TemporaryFolder()

    @Test
    fun `a successful consumer leaves the file alone`() = runBlocking {
        val file = tmp.newFile("image-1.png")

        deleteImageOnFailure(file) { /* consumed fine */ }

        assertTrue(file.exists())
    }

    @Test
    fun `a consumer that throws deletes the file and still propagates`() = runBlocking {
        val file = tmp.newFile("image-2.png")
        val boom = IllegalStateException("insertion unavailable")

        val caught = runCatching {
            deleteImageOnFailure(file) { throw boom }
        }.exceptionOrNull()

        assertFalse(file.exists())
        org.junit.Assert.assertSame(boom, caught)
    }

    @Test
    fun `a cancelled consumer deletes the file and rethrows cancellation`() = runBlocking {
        val file = tmp.newFile("image-3.png")
        val cancellation = CancellationException("session closed")

        val caught = runCatching {
            deleteImageOnFailure(file) { throw cancellation }
        }.exceptionOrNull()

        assertFalse(file.exists())
        org.junit.Assert.assertSame(cancellation, caught)
    }
}
