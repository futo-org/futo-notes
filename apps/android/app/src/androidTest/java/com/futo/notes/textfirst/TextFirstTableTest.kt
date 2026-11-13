package com.futo.notes.textfirst

import android.graphics.Color
import android.view.KeyEvent
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
    @Test fun cellTypingKeepsUnchangedRowLayoutsAndShiftedCellTargets() = runBlocking {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val root = File(context.cacheDir, "table-${UUID.randomUUID()}").apply { check(mkdirs()) }
        val scenario = ActivityScenario.launch(ComponentActivity::class.java)
        val store = NoteStore(root.path)
        lateinit var controller: TextFirstController
        val source = "| Name | Value |\n| --- | --- |\n| first | one |\n| last | tail |\n"
        try {
            store.createNote("grid", "", source)
            withContext(Dispatchers.Main) {
                suspendCancellableCoroutine<Unit> { done -> scenario.onActivity { activity ->
                    controller = createTextFirstController(activity, { store }, root)
                    activity.setContentView(controller.view)
                    controller.open("grid") { assertNull(it); done.resume(Unit) }
                } }
                val editable = controller.view.editableText
                fun rowAt(text: String): TfTableRow {
                    val at = editable.toString().indexOf(text)
                    return editable.getSpans(at, at + text.length, TfTableRow::class.java).single()
                }
                val unchanged = rowAt("tail")
                val changed = rowAt("first")
                val oldStart = editable.getSpanStart(unchanged)
                val at = editable.toString().indexOf("first")
                assertTrue(controller.selectDisplayRange(at, at))
                val connection = controller.cellView!!.onCreateInputConnection(EditorInfo())
                val repaints = mutableListOf<Pair<Int, Int>>()
                val observer = object : android.text.TextWatcher {
                    override fun beforeTextChanged(s: CharSequence, start: Int, count: Int, after: Int) = Unit
                    override fun onTextChanged(s: CharSequence, start: Int, before: Int, count: Int) { repaints += start to start + count }
                    override fun afterTextChanged(s: android.text.Editable) = Unit
                }
                editable.setSpan(observer, 0, editable.length, android.text.Spanned.SPAN_INCLUSIVE_INCLUSIVE)
                suspendCancellableCoroutine<Unit> { done -> connection.handler!!.post {
                    connection.commitText("abc", 1); done.resume(Unit)
                } }
                assertEquals(source.replace("first", "abcfirst"), controller.sourceText())
                val editedRow = rowAt("abcfirst")
                assertEquals("Only the edited row needs layout notification",
                    listOf(editable.getSpanStart(editedRow) to editable.getSpanEnd(editedRow)), repaints)
                editable.removeSpan(observer)
                assertNotSame("The edited row needs new cell layouts", changed, rowAt("abcfirst"))
                assertSame("A shifted but unchanged row must keep its measured layouts", unchanged, rowAt("tail"))
                assertEquals(oldStart + 3, editable.getSpanStart(unchanged))
                val tail = editable.toString().indexOf("tail")
                assertTrue(controller.selectDisplayRange(tail, tail + 4))
                assertEquals("tail", controller.cellView!!.text.toString())
                assertEquals(tail, controller.view.selectionStart)
                controller.undo()
                assertEquals(source, controller.sourceText())
                assertSame(unchanged, rowAt("tail"))
                assertEquals(oldStart, editable.getSpanStart(unchanged))
                assertNotNull(controller.close())
            }
        } finally {
            withContext(Dispatchers.Main) { controller.discard(); controller.dispose() }
            scenario.close(); store.destroy(); root.deleteRecursively()
        }
    }

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
                suspend fun cellKey(code: Int, shift: Boolean = false) {
                    val cellConnection = controller.cellView!!.onCreateInputConnection(EditorInfo())
                    suspendCancellableCoroutine<Unit> { done -> cellConnection.handler!!.post {
                        val down = KeyEvent(0, 0, KeyEvent.ACTION_DOWN, code, 0,
                            if (shift) KeyEvent.META_SHIFT_ON else 0)
                        cellConnection.sendKeyEvent(down)
                        cellConnection.sendKeyEvent(KeyEvent.changeAction(down, KeyEvent.ACTION_UP))
                        done.resume(Unit)
                    } }
                    assertEquals(source, controller.sourceText())
                }
                val header = display.indexOf("名称")
                assertTrue(controller.selectDisplayRange(header, header + 2))
                cellKey(KeyEvent.KEYCODE_TAB)
                assertEquals("Value", controller.cellView?.text.toString())
                assertEquals(display.indexOf("Value"), controller.view.selectionStart)
                assertEquals(display.indexOf("Value") + 5, controller.view.selectionEnd)
                assertEquals(0, controller.cellView!!.selectionStart)
                assertEquals(5, controller.cellView!!.selectionEnd)
                cellKey(KeyEvent.KEYCODE_TAB, shift = true)
                assertEquals("名称", controller.cellView?.text.toString())
                cellKey(KeyEvent.KEYCODE_ENTER)
                assertEquals("café|茶", controller.cellView?.text.toString())
                assertTrue(controller.selectDisplayRange(header, header + 2))
                cellKey(KeyEvent.KEYCODE_NUMPAD_ENTER)
                assertEquals("café|茶", controller.cellView?.text.toString())
                val doneConnection = controller.cellView!!.onCreateInputConnection(EditorInfo())
                suspendCancellableCoroutine<Unit> { done -> doneConnection.handler!!.post {
                    doneConnection.performEditorAction(EditorInfo.IME_ACTION_DONE)
                    done.resume(Unit)
                } }
                assertEquals(source, controller.sourceText())
                assertNull("Done returns to the note", controller.cellView)
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
