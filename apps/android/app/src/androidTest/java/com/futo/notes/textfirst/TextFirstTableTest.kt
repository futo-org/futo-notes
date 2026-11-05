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
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.junit.Assert.*
import org.junit.Test
import uniffi.futo_notes_ffi.NoteStore

/** Real native cell input, canonical session and persisted source; no Markdown implementation mocks. */
class TextFirstTableTest {
    @Test fun cellCompositionSelectionPasteUndoAndReopenPreserveOtherBytes() = runBlocking {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val root = File(context.cacheDir, "table-${UUID.randomUUID()}").apply { check(mkdirs()) }
        val scenario = ActivityScenario.launch(ComponentActivity::class.java)
        val store = NoteStore(root.path)
        lateinit var controller: TextFirstController
        val source = "before" + " sentence".repeat(1000) + "\r\n\r\n| 名称 | Value |\r\n| :--- | ---: |\r\n| café\\|茶 | old |\r\n\r\nafter\r\n"
        try {
            store.createNote("grid", "", source)
            withContext(Dispatchers.Main) {
                suspendCancellableCoroutine<Unit> { done -> scenario.onActivity { activity ->
                    controller = createTextFirstController(activity, { store }, root)
                    activity.setContentView(controller.view)
                    controller.open("grid") { assertNull(it); done.resume(Unit) }
                } }
                controller.select(0)
                val noteConnection = controller.view.onCreateInputConnection(EditorInfo())!!
                suspendCancellableCoroutine<Unit> { done -> noteConnection.handler!!.post {
                    noteConnection.commitText("prefix ", 1); done.resume(Unit)
                } }
                assertEquals("prefix " + source, controller.sourceText())
                // The grid lies past the first open slice: tap it only once it is laid out.
                withTimeout(10_000) { while (!controller.view.contentComplete) delay(10) }
                val view = controller.view
                val width = context.resources.displayMetrics.widthPixels
                val height = context.resources.displayMetrics.heightPixels
                view.measure(android.view.View.MeasureSpec.makeMeasureSpec(width, android.view.View.MeasureSpec.EXACTLY),
                    android.view.View.MeasureSpec.makeMeasureSpec(height, android.view.View.MeasureSpec.EXACTLY))
                view.layout(0, 0, width, height)
                val body = view.text.toString().indexOf("old")
                val line = view.layout.getLineForOffset(body)
                view.scrollTo(0, view.layout.getLineTop(line))
                val x = view.totalPaddingLeft + 240 * context.resources.displayMetrics.density
                val y = view.totalPaddingTop + 10 * context.resources.displayMetrics.density
                val now = android.os.SystemClock.uptimeMillis()
                view.dispatchTouchEvent(android.view.MotionEvent.obtain(now, now, android.view.MotionEvent.ACTION_DOWN, x, y, 0))
                view.dispatchTouchEvent(android.view.MotionEvent.obtain(now, now + 10, android.view.MotionEvent.ACTION_UP, x, y, 0))
                controller.sourceText() // Drain the same public tap command and UI callback.
                assertEquals("A paragraph edit before the grid must shift its tap target", "old", controller.cellView?.text.toString())
                controller.undo()
                assertEquals(source, controller.sourceText())
                val display = controller.view.text.toString()
                val at = display.indexOf("old")
                assertTrue(controller.selectDisplayRange(at, at + 3))
                val field = controller.cellView!!
                assertEquals("old", field.text.toString())
                val connection = field.onCreateInputConnection(EditorInfo())
                suspendCancellableCoroutine<Unit> { done -> connection.handler!!.post {
                    assertEquals("old", connection.getSelectedText(0).toString())
                    assertEquals("", connection.getTextBeforeCursor(1000, 0).toString())
                    assertEquals("", connection.getTextAfterCursor(1000, 0).toString())
                    connection.setSelection(0, 0)
                    connection.deleteSurroundingText(1000, 0)
                    connection.setSelection(0, 3)
                    done.resume(Unit)
                } }
                assertEquals(source, controller.sourceText())
                suspendCancellableCoroutine<Unit> { done -> connection.handler!!.post {
                    connection.setComposingText("新😀", 1)
                    connection.finishComposingText()
                    done.resume(Unit)
                } }
                assertEquals(source.replace("old", "新😀"), controller.sourceText())
                controller.undo()
                assertEquals(source, controller.sourceText())
                assertTrue(controller.selectDisplayRange(at, at + 3))
                context.getSystemService(android.content.ClipboardManager::class.java)
                    .setPrimaryClip(android.content.ClipData.newPlainText(null, "left|right\nend"))
                controller.cellView!!.onTextContextMenuItem(android.R.id.paste)
                assertEquals(source.replace("old", "left\\|right end"), controller.sourceText())
                controller.undo()
                assertEquals(source, controller.sourceText())
                assertTrue(controller.selectDisplayRange(0, 6))
                assertNull("Selecting prose leaves the cell window", controller.cellView)
                suspendCancellableCoroutine<Unit> { done -> connection.handler!!.post {
                    connection.commitText("late cell input", 1)
                    done.resume(Unit)
                } }
                assertEquals(source, controller.sourceText())
                controller.finishCellEditing()
                assertNotNull(controller.close())
                controller.open("grid")
                assertEquals(source, controller.sourceText())
                assertNotNull(controller.close())
            }
        } finally {
            withContext(Dispatchers.Main) { controller.discard(); controller.dispose() }
            scenario.close(); store.destroy(); root.deleteRecursively()
        }
    }

}
