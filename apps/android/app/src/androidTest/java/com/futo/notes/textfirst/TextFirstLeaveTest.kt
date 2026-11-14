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
class TextFirstLeaveTest {
    @Test
    fun failedLeaveRetainsEditableDraftAndRetrySavesLatestText() = runBlocking {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val root = File(context.cacheDir, "leave-${UUID.randomUUID()}").apply { check(mkdirs()) }
        val scenario = ActivityScenario.launch(ComponentActivity::class.java)
        val store = NoteStore(root.path)
        lateinit var controller: TextFirstController
        var initialized = false
        try {
            store.createNote("draft", "", "base\n")
            withContext(Dispatchers.Main) {
                suspendCancellableCoroutine<Unit> { done ->
                    scenario.onActivity { activity ->
                        controller = createTextFirstController(activity, { store }, root)
                        initialized = true
                        activity.setContentView(controller.view)
                        controller.open("draft") { assertNull(it); done.resume(Unit) }
                    }
                }
            }
            val note = File(root, "draft.md")
            check(note.delete())
            check(note.mkdir()) // deterministic save/read failure in this test's own vault
            suspend fun type(text: String) {
                withContext(Dispatchers.Main) {
                    val connection = controller.view.onCreateInputConnection(EditorInfo())!!
                    suspendCancellableCoroutine<Unit> { done ->
                        connection.handler!!.post { connection.commitText(text, 1); done.resume(Unit) }
                    }
                }
            }
            type("draft ")
            assertNull(withContext(Dispatchers.Main) { controller.close() })
            withContext(Dispatchers.Main) { controller.dispose() }
            assertTrue("failed detach keeps the controller attached", controller.opened)
            assertTrue("failed-save disposal retains the editable payload", withContext(Dispatchers.Main) { controller.view.text.toString().contains("draft base") })
            assertEquals("draft base\n", withContext(Dispatchers.Main) { controller.sourceText() })
            type("latest ")
            assertEquals("draft latest base\n", withContext(Dispatchers.Main) { controller.sourceText() })
            check(note.delete())
            note.writeText("base\n")
            assertNotNull(withContext(Dispatchers.Main) { controller.close() })
            assertFalse(controller.opened)
            assertEquals("draft latest base\n", store.read("draft"))
        } finally {
            if (initialized) withContext(Dispatchers.Main) { controller.dispose() }
            scenario.close()
            store.destroy()
            root.deleteRecursively()
        }
    }
    @Test
    fun pendingOpenCannotNavigateWithoutSaving() = runBlocking {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val root = File(context.cacheDir, "pending-open-${UUID.randomUUID()}").apply { check(mkdirs()) }
        val scenario = ActivityScenario.launch(ComponentActivity::class.java)
        val store = NoteStore(root.path)
        val entered = java.util.concurrent.CountDownLatch(1)
        val releaseOpen = java.util.concurrent.CountDownLatch(1)
        val opened = java.util.concurrent.CountDownLatch(1)
        lateinit var controller: TextFirstController
        try {
            store.createNote("draft", "", "base\n")
            scenario.onActivity { activity ->
                controller = createTextFirstController(activity, {
                    entered.countDown()
                    check(releaseOpen.await(10, java.util.concurrent.TimeUnit.SECONDS))
                    store
                }, root)
                activity.setContentView(controller.view)
                controller.open("draft") { assertNull(it); opened.countDown() }
            }
            assertTrue(entered.await(10, java.util.concurrent.TimeUnit.SECONDS))
            withContext(Dispatchers.Main) {
                assertFalse("a pending open is not a successfully closed editor", controller.canNavigateWithoutSaving)
            }
            releaseOpen.countDown()
            assertTrue(opened.await(10, java.util.concurrent.TimeUnit.SECONDS))
            withContext(Dispatchers.Main) {
                assertFalse(controller.canNavigateWithoutSaving)
                assertNotNull(controller.close())
                assertTrue(controller.canNavigateWithoutSaving)
            }
        } finally {
            releaseOpen.countDown()
            withContext(Dispatchers.Main) { controller.discard(); controller.dispose() }
            scenario.close()
            store.destroy()
            root.deleteRecursively()
        }
    }

    @Test
    fun disposingASavedEditorReleasesPayloadAfterTheScrollAnchorCanBeCaptured() = runBlocking {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val root = File(context.cacheDir, "leave-payload-${UUID.randomUUID()}").apply { check(mkdirs()) }
        val scenario = ActivityScenario.launch(ComponentActivity::class.java)
        val store = NoteStore(root.path)
        val opened = java.util.concurrent.CountDownLatch(1)
        val drawn = java.util.concurrent.CountDownLatch(1)
        lateinit var controller: TextFirstController
        lateinit var retainedEngine: EditorEngine
        try {
            store.createNote("large", "", "```\n" + "code row\n".repeat(4_000) + "```\n")
            scenario.onActivity { activity ->
                controller = createTextFirstController(activity, { store }, root)
                activity.setContentView(controller.view)
                controller.view.onRenderFrame = { if (opened.count == 0L && controller.view.contentComplete) drawn.countDown() }
                controller.open("large") { assertNull(it); opened.countDown() }
            }
            assertTrue(opened.await(10, java.util.concurrent.TimeUnit.SECONDS))
            assertTrue(drawn.await(10, java.util.concurrent.TimeUnit.SECONDS))
            withContext(Dispatchers.Main) {
                val view = controller.view
                retainedEngine = view.engine!!
                view.scrollTo(0, 800)
                val anchor = view.scrollAnchor()
                assertTrue(view.length() > 30_000)
                assertNotNull(controller.close())
                val afterClose = view.scrollAnchor()
                assertNotNull(anchor)
                assertNotNull(afterClose)
                assertEquals("navigation captures the reader's offset after close", anchor!!.offset, afterClose!!.offset)
                assertEquals("navigation captures the reader's line inset after close", anchor.intoLine, afterClose.intoLine)
                assertTrue("close keeps the view intact until final disposal", view.length() > 30_000)
                controller.dispose()
                assertEquals("a platform-retained view must not retain the previous note", TextFirstEditText.END_SENTINEL.length, view.length())
                assertEquals(TextFirstEditText.END_SENTINEL, view.text.toString())
                assertNull(view.onRenderFrame)
                assertNull(view.onApplyMeasured)
                assertNull(view.onFrameDrawn)
                val exact = android.view.View.MeasureSpec.EXACTLY
                view.measure(android.view.View.MeasureSpec.makeMeasureSpec(800, exact), android.view.View.MeasureSpec.makeMeasureSpec(600, exact))
                view.layout(0, 0, 800, 600)
                assertTrue("the retained native layout is small", view.layout.lineCount <= 2)
            }
            // Retaining an old IC or publisher must not keep a closed note's
            // mirror capacity/index or provisional/cell state alive.
            assertTrue(retainedEngine.closed)
            assertEquals(0, retainedEngine.mirror.text.length)
            assertEquals(0, retainedEngine.mirror.text.capacity())
            assertEquals(0, retainedEngine.mirror.utf8Length)
            assertEquals(0, retainedEngine.selStart)
            assertEquals(0, retainedEngine.selEnd)
            assertNull(retainedEngine.mirror.overlay)
            assertFalse(retainedEngine.editingCell)
            assertNull(retainedEngine.cellRange)
        } finally {
            withContext(Dispatchers.Main) { controller.dispose() }
            scenario.close()
            store.destroy()
            root.deleteRecursively()
        }
    }
}
