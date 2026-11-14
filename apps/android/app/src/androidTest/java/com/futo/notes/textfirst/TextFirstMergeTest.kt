package com.futo.notes.textfirst

import android.graphics.Color
import android.view.inputmethod.EditorInfo
import androidx.activity.ComponentActivity
import androidx.core.content.res.ResourcesCompat
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import com.futo.notes.R
import java.io.File
import java.util.UUID
import kotlin.coroutines.resume
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import org.junit.Assert.*
import org.junit.Test
import uniffi.futo_notes_ffi.NoteStore

/** Real native input and the public controller leave boundary, backed by the real Store. */
class TextFirstMergeTest {
    @Test
    fun checkpointAdoptsPeerTextBeforePublishingSavedStateAndUndoRetainsPeer() = runBlocking {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val root = File(context.cacheDir, "merge-${UUID.randomUUID()}").apply { check(mkdirs()) }
        val scenario = ActivityScenario.launch(ComponentActivity::class.java)
        val store = NoteStore(root.path)
        lateinit var controller: TextFirstController
        try {
            store.createNote("draft", "", "first\n\nsecond\n")
            withContext(Dispatchers.Main) {
                suspendCancellableCoroutine<Unit> { done ->
                    scenario.onActivity { activity ->
                        controller = createTextFirstController(activity, { store }, root)
                        activity.setContentView(controller.view)
                        controller.open("draft") { assertNull(it); done.resume(Unit) }
                    }
                }
                val connection = controller.view.onCreateInputConnection(EditorInfo())!!
                suspendCancellableCoroutine<Unit> { done ->
                    connection.handler!!.post { connection.commitText("local ", 1); done.resume(Unit) }
                }
            }
            File(root, "draft.md").writeText("first\n\npeer second\n")
            withContext(Dispatchers.Main) {
                assertNotNull(controller.checkpoint())
                assertEquals("local first\n\npeer second\n", controller.sourceText())
                assertFalse("coordinated adoption is saved, not a new dirty edit", controller.dirty)
                controller.undo()
                assertEquals("first\n\npeer second\n", controller.sourceText())
                controller.redo()
                assertEquals("local first\n\npeer second\n", controller.sourceText())
                assertNotNull(controller.close())
            }
            assertEquals("local first\n\npeer second\n", store.read("draft"))
        } finally {
            withContext(Dispatchers.Main) { controller.discard(); controller.dispose() }
            scenario.close()
            store.destroy()
            root.deleteRecursively()
        }
    }

    @Test
    fun sameParagraphMergeRetainsSelectionAndLocalUndo() = withEditor("red cat and blue dog\n") { store, controller, root ->
        controller.select(0, 3)
        type(controller, "green")
        File(root, "draft.md").writeText("red cat and blue fox\n")
        controller.reconcileExternalChanges()
        assertEquals("green cat and blue fox\n", controller.sourceText())
        assertEquals(5, controller.view.selectionStart)
        assertEquals(5, controller.view.selectionEnd)
        assertFalse(controller.dirty)
        controller.undo()
        assertEquals("red cat and blue fox\n", controller.sourceText())
        controller.redo()
        assertEquals("green cat and blue fox\n", controller.sourceText())
        assertNotNull(controller.close())
        assertEquals("green cat and blue fox\n", store.read("draft"))
        store.openEditor("draft").use { reopened ->
            assertEquals("green cat and blue fox\n", reopened.sourceText())
            reopened.detach()
        }
    }

    @Test
    fun ambiguousOverlapUsesAuthoritativeParkedIdentity() = withEditor("red cat\n") { store, controller, root ->
        controller.select(0, 3)
        type(controller, "green")
        File(root, "draft.md").writeText("blue cat\n")
        var finalId: String? = null
        controller.onCheckpointed = { result, id ->
            assertTrue(result.disposition is uniffi.futo_notes_ffi.FlushDisposition.ParkedConflict)
            assertEquals(id, result.mutation?.finalId)
            finalId = id
        }
        controller.reconcileExternalChanges()
        assertNotEquals("draft", finalId)
        assertEquals("green cat\n", controller.sourceText())
        assertEquals("blue cat\n", store.read("draft"))
        assertEquals("green cat\n", store.read(checkNotNull(finalId)))
        controller.onCheckpointed = { _, _ -> }
    }

    @Test
    fun dirtyRemoteRenameAndFailedSaveRetainFinalAttachment() = withEditor("first\n\nsecond\n") { store, controller, root ->
        type(controller, "local ")
        val old = File(root, "draft.md")
        val renamed = File(root, "renamed.md")
        check(old.renameTo(renamed))
        renamed.writeText("first\n\npeer second\n")
        val mutation = store.refreshExternalChanges(listOf("renamed"), listOf("draft"),
            listOf(uniffi.futo_notes_ffi.RenamePair("draft", "renamed")))
        assertTrue(mutation.upserted.any { it.note.id == "renamed" })
        var attachment: String? = null
        controller.onAttachmentChanged = { attachment = it }
        check(renamed.delete()); check(renamed.mkdir())
        controller.reconcileExternalChanges()
        assertEquals("renamed", attachment)
        assertEquals("local first\n\nsecond\n", controller.sourceText())
        assertFalse(old.exists())
        check(renamed.delete()); renamed.writeText("first\n\npeer second\n")
        assertNotNull(controller.checkpoint())
        assertEquals("local first\n\npeer second\n", controller.sourceText())
        assertNotNull(controller.close())
        assertFalse(old.exists())
        assertEquals("local first\n\npeer second\n", store.read("renamed"))
    }

    @Test
    fun cleanPeerRefreshKeepsPriorLocalUndoAndDoesNotReopen() = withEditor("first\n\nsecond\n") { store, controller, root ->
        type(controller, "local ")
        assertNotNull(controller.checkpoint())
        File(root, "draft.md").writeText("local first\n\npeer second\n")
        controller.reconcileExternalChanges()
        assertEquals("local first\n\npeer second\n", controller.sourceText())
        controller.undo()
        assertEquals("first\n\npeer second\n", controller.sourceText())
        controller.redo()
        assertEquals("local first\n\npeer second\n", controller.sourceText())
        assertNotNull(controller.close())
        assertEquals("local first\n\npeer second\n", store.read("draft"))
    }

    @Test
    fun outsideMergeSettlesCompositionThroughNativeInputMirror() = withEditor("first\n\nsecond\n") { _, controller, root ->
        type(controller, "local ", composing = true)
        File(root, "draft.md").writeText("first\n\npeer second\n")
        controller.reconcileExternalChanges()
        assertEquals("local first\n\npeer second\n", controller.sourceText())
        assertEquals(-1, android.view.inputmethod.BaseInputConnection.getComposingSpanStart(checkNotNull(controller.view.text)))
        controller.undo()
        assertEquals("first\n\npeer second\n", controller.sourceText())
    }

    @Test
    fun failedMergeSaveStillDrainsSettledCompositionBeforeRetry() = withEditor("first\n\nsecond\n") { _, controller, root ->
        type(controller, "local ", composing = true)
        File(root, "draft.md").writeText("first\n\npeer second\n")
        check(root.setWritable(false, false))
        var failed = false
        controller.onFailure = { failed = true }
        try {
            controller.reconcileExternalChanges()
            assertTrue("outside read settles composition before the failing write", failed)
            assertEquals("local first\n\nsecond\n", controller.sourceText())
            assertEquals(-1, android.view.inputmethod.BaseInputConnection.getComposingSpanStart(checkNotNull(controller.view.text)))
            assertTrue(controller.dirty)
        } finally { check(root.setWritable(true, true)) }
        assertNotNull(controller.checkpoint())
        assertEquals("local first\n\npeer second\n", controller.sourceText())
        controller.undo()
        assertEquals("first\n\npeer second\n", controller.sourceText())
    }

    private suspend fun type(controller: TextFirstController, text: String, composing: Boolean = false) {
        val input = checkNotNull(controller.view.onCreateInputConnection(EditorInfo()))
        suspendCancellableCoroutine<Unit> { done ->
            input.handler!!.post {
                if (composing) input.setComposingText(text, 1) else input.commitText(text, 1)
                done.resume(Unit)
            }
        }
    }

    private fun withEditor(base: String, block: suspend (NoteStore, TextFirstController, File) -> Unit) = runBlocking {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val root = File(context.cacheDir, "adoption-${UUID.randomUUID()}").apply { check(mkdirs()) }
        val scenario = ActivityScenario.launch(ComponentActivity::class.java)
        val store = NoteStore(root.path)
        lateinit var controller: TextFirstController
        try {
            store.createNote("draft", "", base)
            withContext(Dispatchers.Main) {
                suspendCancellableCoroutine<Unit> { done ->
                    scenario.onActivity { activity ->
                        controller = createTextFirstController(activity, { store }, root)
                        activity.setContentView(controller.view)
                        controller.open("draft") { assertNull(it); done.resume(Unit) }
                    }
                }
                block(store, controller, root)
            }
        } finally {
            withContext(Dispatchers.Main) { controller.discard(); controller.dispose() }
            scenario.close()
            store.destroy()
            root.deleteRecursively()
        }
    }

}
