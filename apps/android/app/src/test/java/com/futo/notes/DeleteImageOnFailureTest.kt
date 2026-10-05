package com.futo.notes

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
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
    fun `a failing or cancelled consumer deletes the file and rethrows`() = runBlocking {
        listOf(
            IllegalStateException("insertion unavailable"),
            // Catching `Exception` also catches cancellation; it must still
            // clean up and propagate rather than be swallowed.
            CancellationException("session closed"),
        ).forEachIndexed { index, failure ->
            val file = tmp.newFile("image-failed-$index.png")

            val caught = runCatching {
                deleteImageOnFailure(file) { throw failure }
            }.exceptionOrNull()

            assertFalse(file.exists())
            assertSame(failure, caught)
        }
    }
}
