package com.futo.notes.textfirst

import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.Assert.*
import org.junit.Test
import uniffi.futo_notes_ffi.EditorInlineFormat
import uniffi.futo_notes_ffi.EditorSessionException
import uniffi.futo_notes_ffi.FlushDraftResult
import uniffi.futo_notes_ffi.NoteStore

/** Toolbar admission at the real editor-thread boundary, independently of device speed. */
class TextFirstCommandQueueTest {
    @Test fun repeatedToolbarTapsDoNotQueueWhileTheEditorIsBusy() = exercise { engine ->
        val busy = CountDownLatch(1)
        val resume = CountDownLatch(1)
        engine.handler.post { busy.countDown(); check(resume.await(10, TimeUnit.SECONDS)) }
        assertTrue(busy.await(10, TimeUnit.SECONDS))
        try {
            engine.toggleFormat(EditorInlineFormat.BOLD)
            engine.toggleFormat(EditorInlineFormat.BOLD)
        } finally { resume.countDown() }
        val checked = CountDownLatch(1)
        var formats: List<EditorInlineFormat>? = null
        engine.handler.post { formats = engine.session!!.activeFormats(); checked.countDown() }
        assertTrue(checked.await(10, TimeUnit.SECONDS))
        assertEquals(listOf(EditorInlineFormat.BOLD), formats)
    }

    @Test fun leavingCancelsToolbarActionsWaitingForTheEditorThread() = exercise { engine ->
        val busy = CountDownLatch(1)
        val resume = CountDownLatch(1)
        engine.handler.post { busy.countDown(); check(resume.await(10, TimeUnit.SECONDS)) }
        assertTrue(busy.await(10, TimeUnit.SECONDS))
        val closed = CountDownLatch(1)
        try {
            engine.blockCommand(uniffi.futo_notes_ffi.EditorBlockCommand.Heading(1u))
            engine.close { closed.countDown() }
        } finally { resume.countDown() }
        assertTrue(closed.await(10, TimeUnit.SECONDS))
        assertEquals("plain", storeForCheck!!.read("n"))
    }

    @Test fun leavingKeepsAcceptedKeyboardInputWhileCancellingToolbarWork() = exercise { engine ->
        val busy = CountDownLatch(1)
        val resume = CountDownLatch(1)
        engine.handler.post { busy.countDown(); check(resume.await(10, TimeUnit.SECONDS)) }
        assertTrue(busy.await(10, TimeUnit.SECONDS))
        val closed = CountDownLatch(1)
        try {
            // An accepted keyboard request precedes navigation. Cancel only
            // the waiting toolbar action, then save the keyboard's bytes.
            engine.handler.post { engine.imeCommit("x") }
            engine.blockCommand(uniffi.futo_notes_ffi.EditorBlockCommand.Heading(1u))
            engine.close { closed.countDown() }
        } finally { resume.countDown() }
        assertTrue(closed.await(10, TimeUnit.SECONDS))
        assertEquals("xplain", storeForCheck!!.read("n"))
    }

    private var storeForCheck: NoteStore? = null
    private fun exercise(check: (EditorEngine) -> Unit) {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val root = File(context.cacheDir, "command-queue-${UUID.randomUUID()}").apply { check(mkdirs()) }
        val store = NoteStore(root.path)
        storeForCheck = store
        val opened = CountDownLatch(1)
        val engine = EditorEngine({ store }, "n", object : EngineSink {
            override fun onUpdate(update: UiUpdate) {}
            override fun onCaretState(state: CaretState) {}
            override fun onAttachmentId(noteId: String) {}
            override fun onCheckpoint(result: FlushDraftResult, noteId: String) {}
            override fun onFailure(error: EditorSessionException) { throw AssertionError(error) }
            override fun onImeReset() {}
        })
        try {
            store.createNote("n", "", "plain")
            engine.open { assertNull(it); opened.countDown() }
            assertTrue(opened.await(10, TimeUnit.SECONDS))
            check(engine)
        } finally {
            val released = CountDownLatch(1)
            engine.discard { released.countDown() }
            // A successful close has already stopped this handler.
            if (!engine.closed) assertTrue(released.await(10, TimeUnit.SECONDS))
            store.destroy()
            root.deleteRecursively()
        }
    }
}
