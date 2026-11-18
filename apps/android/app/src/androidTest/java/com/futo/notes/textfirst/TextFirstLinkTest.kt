package com.futo.notes.textfirst

import android.graphics.Color
import android.view.KeyEvent
import android.view.MotionEvent
import android.os.SystemClock
import android.view.View
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

/** Native controller + real engine/store seam for the toolbar link dialog. */
class TextFirstLinkTest {
    @Test
    fun inspectExistingLinkDoesNotEditAndUnlinkPreservesLabelAndUndo() = runBlocking {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val root = File(context.cacheDir, "links-${UUID.randomUUID()}").apply { check(mkdirs()) }
        val scenario = ActivityScenario.launch(ComponentActivity::class.java)
        val store = NoteStore(root.path)
        lateinit var controller: TextFirstController
        val source = "before [café](https://old.test) after\n"
        try {
            store.createNote("links", "", source)
            withContext(Dispatchers.Main) {
                suspendCancellableCoroutine<Unit> { done ->
                    scenario.onActivity { activity ->
                        controller = createTextFirstController(activity, { store }, root)
                        activity.setContentView(controller.view)
                        controller.open("links") { assertNull(it); done.resume(Unit) }
                    }
                }
                controller.select(9)
                val link = controller.linkDraft()
                assertNotNull("Toolbar Link must inspect the attached engine selection", link)
                assertEquals("café", link!!.label)
                assertEquals("https://old.test", link.destination)
                assertTrue(link.existing)
                assertEquals(source, controller.sourceText()) // Cancel is no command.
                assertTrue(controller.removeLink(link))
                assertEquals("before café after\n", controller.sourceText())
                controller.undo()
                assertEquals(source, controller.sourceText())
                assertNotNull(controller.close())
                controller.open("links")
                assertEquals(source, controller.sourceText())
                assertNotNull(controller.close())
            }
        } finally {
            withContext(Dispatchers.Main) { controller.discard(); controller.dispose() }
            scenario.close()
            store.destroy()
            root.deleteRecursively()
        }
    }

    @Test
    fun insertAndChangeLabelAndDestinationAreEachOneUndoAndPersistOnReopen() = runBlocking {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val root = File(context.cacheDir, "link-edit-${UUID.randomUUID()}").apply { check(mkdirs()) }
        val scenario = ActivityScenario.launch(ComponentActivity::class.java)
        val store = NoteStore(root.path)
        lateinit var controller: TextFirstController
        val source = "before word after\n"
        try {
            store.createNote("links", "", source)
            withContext(Dispatchers.Main) {
                suspendCancellableCoroutine<Unit> { done ->
                    scenario.onActivity { activity ->
                        controller = createTextFirstController(activity, { store }, root)
                        activity.setContentView(controller.view)
                        controller.open("links") { assertNull(it); done.resume(Unit) }
                    }
                }
                controller.select(7, 11)
                val insertion = controller.linkDraft()!!
                assertFalse(insertion.existing)
                assertEquals("word", insertion.label)
                assertTrue(controller.editLink(insertion, "FUTO", "https://futo.org"))
                assertEquals("before [FUTO](https://futo.org) after\n", controller.sourceText())
                controller.undo()
                assertEquals(source, controller.sourceText())
                controller.redo()
                controller.select(8)
                val existing = controller.linkDraft()!!
                assertTrue(controller.editLink(existing, "café", "https://next.test"))
                assertEquals("before [café](https://next.test) after\n", controller.sourceText())
                controller.undo()
                assertEquals("before [FUTO](https://futo.org) after\n", controller.sourceText())
                controller.redo()
                // Leaving cancels a toolbar action that has not started (performance.md):
                // the Redo must land before the note closes.
                assertEquals("before [café](https://next.test) after\n", controller.sourceText())
                assertNotNull(controller.close())
                controller.open("links")
                assertEquals("before [café](https://next.test) after\n", controller.sourceText())
                assertFalse("draft claims cannot edit a reopened attachment", controller.editLink(existing, "wrong", "https://wrong.test"))
                assertNotNull(controller.close())
            }
        } finally {
            withContext(Dispatchers.Main) { controller.discard(); controller.dispose() }
            scenario.close()
            store.destroy()
            root.deleteRecursively()
        }
    }

    @Test
    fun composingTextSettlesBeforeDialogAndLateInputInvalidatesItsClaim() = runBlocking {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val root = File(context.cacheDir, "link-compose-${UUID.randomUUID()}").apply { check(mkdirs()) }
        val scenario = ActivityScenario.launch(ComponentActivity::class.java)
        val store = NoteStore(root.path)
        lateinit var controller: TextFirstController
        try {
            store.createNote("links", "", "before  after\n")
            withContext(Dispatchers.Main) {
                suspendCancellableCoroutine<Unit> { done ->
                    scenario.onActivity { activity ->
                        controller = createTextFirstController(activity, { store }, root)
                        activity.setContentView(controller.view)
                        controller.open("links") { assertNull(it); done.resume(Unit) }
                    }
                }
                controller.select(7)
                val connection = controller.view.onCreateInputConnection(EditorInfo())!!
                suspendCancellableCoroutine<Unit> { done ->
                    connection.handler!!.post { connection.setComposingText("café", 1); done.resume(Unit) }
                }
                val insertion = controller.linkDraft()!!
                assertEquals("before café after\n", controller.sourceText())
                assertFalse(insertion.existing)
                assertTrue(controller.editLink(insertion, "FUTO", "https://futo.org"))
                assertEquals("before café[FUTO](https://futo.org) after\n", controller.sourceText())
                controller.undo()
                assertEquals("before café after\n", controller.sourceText())
                controller.select(7, 11)
                val selected = controller.linkDraft()!!
                assertEquals("café", selected.label)
                controller.select(0)
                suspendCancellableCoroutine<Unit> { done ->
                    connection.handler!!.post { connection.commitText("new ", 1); done.resume(Unit) }
                }
                assertFalse("late editor input must invalidate a dialog claim", controller.editLink(selected, "wrong", "https://wrong.test"))
                assertEquals("new before café after\n", controller.sourceText())
                assertNotNull(controller.close())
            }
        } finally {
            withContext(Dispatchers.Main) { controller.discard(); controller.dispose() }
            scenario.close()
            store.destroy()
            root.deleteRecursively()
        }
    }

    @Test
    fun longWikilinkFitsTheViewportWithoutChangingItsSource() = runBlocking {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val root = File(context.cacheDir, "wikilink-wrap-${UUID.randomUUID()}").apply { check(mkdirs()) }
        val scenario = ActivityScenario.launch(ComponentActivity::class.java)
        val store = NoteStore(root.path)
        lateinit var controller: TextFirstController
        val source = "Before [[A very long wikilink label that should wrap across multiple visible lines and remain readable while editing]] after\n"
        try {
            store.createNote("wrap", "", source)
            withContext(Dispatchers.Main) {
                suspendCancellableCoroutine<Unit> { done ->
                    scenario.onActivity { activity ->
                        controller = createTextFirstController(activity, { store }, root)
                        activity.setContentView(controller.view)
                        controller.open("wrap") { assertNull(it); done.resume(Unit) }
                    }
                }
                val view = controller.view
                val width = (320 * context.resources.displayMetrics.density).toInt()
                view.measure(View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY),
                    View.MeasureSpec.makeMeasureSpec(2000, View.MeasureSpec.EXACTLY))
                view.layout(0, 0, width, 2000)
                val layout = view.layout
                val available = width - view.compoundPaddingLeft - view.compoundPaddingRight
                for (line in 0 until layout.lineCount) {
                    assertTrue("line $line extends beyond the viewport: ${layout.getLineWidth(line)} > $available",
                        layout.getLineWidth(line) <= available + 1)
                }
                assertTrue("a long linked label must occupy multiple visible lines", layout.lineCount >= 3)
                assertEquals(source, controller.sourceText())
                assertNotNull(controller.close())
                controller.open("wrap")
                assertEquals(source, controller.sourceText())
                assertNotNull(controller.close())
            }
        } finally {
            withContext(Dispatchers.Main) { controller.discard(); controller.dispose() }
            scenario.close()
            store.destroy()
            root.deleteRecursively()
        }
    }

    @Test
    fun wrappedWikilinkTapsNavigateWithoutEatingSelectionOrAdjacentInput() = runBlocking {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val root = File(context.cacheDir, "wikilink-input-${UUID.randomUUID()}").apply { check(mkdirs()) }
        val scenario = ActivityScenario.launch(ComponentActivity::class.java)
        val store = NoteStore(root.path)
        lateinit var controller: TextFirstController
        val label = "A long linked title with café 🦊 and many words that wrap across several lines"
        val target = "folder/$label"
        val source = "Before [[$target]] after\n"
        val start = 7
        val end = source.indexOf("]] after") + 2
        try {
            store.createFolder("folder")
            store.createNote(label, "folder", "destination")
            store.createNote("wrap", "", source)
            withContext(Dispatchers.Main) {
                suspendCancellableCoroutine<Unit> { done ->
                    scenario.onActivity { activity ->
                        controller = createTextFirstController(activity, { store }, root)
                        activity.setContentView(controller.view)
                        controller.open("wrap") { assertNull(it); done.resume(Unit) }
                    }
                }
                val view = controller.view
                val width = (320 * context.resources.displayMetrics.density).toInt()
                fun layout(width: Int) {
                    view.measure(View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY),
                        View.MeasureSpec.makeMeasureSpec(2000, View.MeasureSpec.EXACTLY))
                    view.layout(0, 0, width, 2000)
                }
                layout(width)
                val row = view.layout.getLineForOffset(start)
                val tall = view.layout.getLineBottom(row) - view.layout.getLineTop(row)
                assertTrue("wrapped label reserves its full visual height", tall > view.paint.fontSpacing * 2)
                val opened = mutableListOf<String>()
                view.onOpenWikilink = { opened.add(it) }
                val x = view.totalPaddingLeft + view.paint.textSize
                val firstY = view.totalPaddingTop + view.layout.getLineTop(row) + view.paint.textSize
                val lastY = view.totalPaddingTop + view.layout.getLineBaseline(row) - view.paint.textSize / 2
                fun touch(y: Float, duration: Long = 20, move: Boolean = false) {
                    val down = SystemClock.uptimeMillis()
                    fun event(action: Int, time: Long, atX: Float) {
                        val e = MotionEvent.obtain(down, time, action, atX, y, 0)
                        try { view.dispatchTouchEvent(e) } finally { e.recycle() }
                    }
                    event(MotionEvent.ACTION_DOWN, down, x)
                    if (move) event(MotionEvent.ACTION_MOVE, down + duration / 2, x + 80)
                    event(MotionEvent.ACTION_UP, down + duration, if (move) x + 80 else x)
                }
                touch(firstY)
                touch(lastY)
                assertEquals("every visual line reaches the same projected destination", listOf(target, target), opened)
                touch(firstY, 800)
                touch(firstY, move = true)
                assertEquals("holding or dragging a link must not navigate", 2, opened.size)
                view.setSelection(start + 2)
                controller.sourceText()
                assertEquals(start, view.selectionStart)
                view.setSelection(end - 2)
                controller.sourceText()
                assertEquals(end, view.selectionStart)
                val connection = view.onCreateInputConnection(EditorInfo())!!
                controller.select(end)
                suspendCancellableCoroutine<Unit> { done ->
                    connection.handler!!.post { connection.commitText("X", 1); done.resume(Unit) }
                }
                assertEquals(source.replace("]] after", "]]X after"), controller.sourceText())
                controller.undo()
                assertEquals(source, controller.sourceText())
                controller.select(start)
                suspendCancellableCoroutine<Unit> { done ->
                    connection.handler!!.post { connection.commitText("Y", 1); done.resume(Unit) }
                }
                assertEquals(source.replace("Before [[", "Before Y[["), controller.sourceText())
                controller.undo()
                assertEquals(source, controller.sourceText())
                view.setSelection(start)
                view.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_DPAD_RIGHT))
                view.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_DPAD_RIGHT))
                controller.sourceText()
                assertEquals("caret crosses the whole linked object", end, view.selectionStart)
                view.setSelection(start + 2, end - 2)
                controller.sourceText()
                assertEquals(start, view.selectionStart)
                assertEquals(end, view.selectionEnd)
                suspendCancellableCoroutine<Unit> { done ->
                    connection.handler!!.post { connection.commitText("replacement", 1); done.resume(Unit) }
                }
                assertEquals("Before replacement after\n", controller.sourceText())
                controller.undo()
                assertEquals(source, controller.sourceText())
                layout(width * 2)
                val wideRow = view.layout.getLineForOffset(start)
                val wideHeight = view.layout.getLineBottom(wideRow) - view.layout.getLineTop(wideRow)
                assertTrue("width changes reflow the label", wideHeight < tall)
                assertNotNull(controller.close())
                controller.open("wrap")
                assertEquals(source, controller.sourceText())
                assertNotNull(controller.close())
            }
        } finally {
            withContext(Dispatchers.Main) { controller.discard(); controller.dispose() }
            scenario.close()
            store.destroy()
            root.deleteRecursively()
        }
    }

}
