package com.futo.notes.textfirst

import android.text.Selection
import androidx.activity.ComponentActivity
import androidx.test.core.app.ActivityScenario
import androidx.test.filters.SdkSuppress
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.util.UUID
import kotlin.coroutines.resume
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.junit.Assert.*
import org.junit.Test
import uniffi.futo_notes_ffi.NoteStore

/** A list row's marker and its native selection highlight are painted together. */
class TextFirstListSelectionPaintTest {
    /** Hardware Layout caches span drawing separately from the native selection path. */
    @SdkSuppress(minSdkVersion = 29)
    @Test fun listMarkersFollowNativeSelectionWithoutATextChange() = runBlocking {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val root = File(context.cacheDir, "marker-selection-${UUID.randomUUID()}").apply { check(mkdirs()) }
        val scenario = ActivityScenario.launch(ComponentActivity::class.java)
        val store = NoteStore(root.path)
        lateinit var controller: TextFirstController
        try {
            val sources = listOf("- Dispatch\n- Archive\n- File", "1. Dispatch\n2. Archive\n3. File", "- [ ] Dispatch\n- [ ] Archive\n- [ ] File", "99. Dispatch\n100. Archive\n101. File", "- אבגדהוזח\n- אבגדהוז\n- אבגד")
                .map { it + "\n\nplain\n".repeat(80) }
            sources.forEachIndexed { i, raw -> store.createNote("n$i", "", raw) }
            withContext(Dispatchers.Main) {
                scenario.onActivity { activity ->
                    controller = createTextFirstController(activity, { store }, root)
                    activity.setContentView(controller.view)
                }
                for (i in sources.indices) {
                    suspendCancellableCoroutine<Unit> { done ->
                        controller.open("n$i") { assertNull(it); done.resume(Unit) }
                    }
                    val view = controller.view
                    view.isFocusableInTouchMode = true
                    view.requestFocusFromTouch()
                    Selection.setSelection(view.editableText, 0)
                    committedFrame(view)
                    assertTrue("the regression exercises hardware Layout drawing", view.isHardwareAccelerated)
                    val ys = (0..2).map { view.totalPaddingTop + view.layout.getLineTop(it) + view.style.dp(2f).toInt() }
                    suspend fun assertMarkers(start: Int, end: Int, selectedRows: Set<Int>) {
                        val shot = copyViewPixels(view)
                        try {
                            for (row in ys.indices) {
                                val dir = view.layout.getParagraphDirection(row)
                                val bodyEdge = view.totalPaddingLeft + view.layout.getPrimaryHorizontal(view.layout.getLineStart(row)).toInt()
                                val markerX = view.totalPaddingLeft + if (dir > 0) 1 else view.layout.width - 2
                                val body = shot.getPixel(bodyEdge + dir * 4, ys[row])
                                val background = shot.getPixel(1, ys[row])
                                if (row in selectedRows) assertNotEquals("the native body selection is drawn", background, body)
                                // Compare one frame: window transitions can change its overall brightness.
                                val expected = if (row in selectedRows) body else background
                                assertEquals("${sources[i].substringBefore('\n')}: selection $start..$end, marker row $row", expected, shot.getPixel(markerX, ys[row]))
                                // The custom gutter meets Layout's integer body edge without
                                // painting the translucent highlight twice on that boundary.
                                for (edgeX in bodyEdge - 1..bodyEdge + 1) {
                                    assertEquals("selection $start..$end, row $row, body edge $edgeX", expected, shot.getPixel(edgeX, ys[row]))
                                }
                            }
                        } finally { shot.recycle() }
                    }
                    suspend fun selection(start: Int, end: Int, selectedRows: Set<Int>) {
                        Selection.setSelection(view.editableText, start, end)
                        committedFrame(view)
                        assertMarkers(start, end, selectedRows)
                    }
                    selection(0, 21, setOf(0, 1, 2))
                    selection(4, 4, emptySet())
                    selection(21, 0, setOf(0, 1, 2))
                    selection(1, 4, emptySet())
                    selection(9, 16, setOf(1))
                    selection(17, 21, setOf(2))
                    selection(0, 21, setOf(0, 1, 2))
                    view.scrollTo(0, view.layout.height - view.height)
                    committedFrame(view)
                    assertTrue("selected markers were scrolled off screen", view.scrollY > view.layout.getLineBottom(2))
                    val last = view.length() - 1
                    Selection.setSelection(view.editableText, last)
                    committedFrame(view)
                    view.scrollTo(0, 0)
                    committedFrame(view)
                    assertMarkers(last, last, emptySet())
                    assertEquals("selection alone retains exact Markdown", sources[i], controller.sourceText())
                    controller.discard()
                }
            }
        } finally {
            withContext(Dispatchers.Main) { controller.discard(); controller.dispose() }
            scenario.close()
            store.destroy()
            root.deleteRecursively()
        }
    }

    @SdkSuppress(minSdkVersion = 29)
    @Test fun emptyListRowsHighlightOnlyTheirSelectedNewline() = runBlocking {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val root = File(context.cacheDir, "empty-marker-${UUID.randomUUID()}").apply { check(mkdirs()) }
        val scenario = ActivityScenario.launch(ComponentActivity::class.java)
        lateinit var controller: TextFirstController
        try {
            withContext(Dispatchers.Main) {
                scenario.onActivity { activity ->
                    controller = createTextFirstController(activity, { error("renderer fixture never opens a note") }, root)
                    activity.setContentView(controller.view)
                }
                val view = controller.view
                view.isFocusableInTouchMode = true
                view.requestFocusFromTouch()
                var seq = 1
                for (kind in ListMarker.entries) for (rtl in listOf(false, true)) for (newline in listOf("\n", "\r\n")) {
                    view.textDirection = if (rtl) android.view.View.TEXT_DIRECTION_RTL else android.view.View.TEXT_DIRECTION_LTR
                    val label = if (rtl) "אריזה" else "Parcel"
                    val middle = newline.length
                    val last = middle + label.length + newline.length
                    suspend fun install(ending: String) {
                        val body = newline + label + newline + ending
                        view.apply(UiUpdate(seq++, body, emptyList(), 0, 0, -1, -1,
                            listOf(StyleWindow(0, body.length, listOf(
                                SpanSpec.ListRow(0, middle, 0, kind, "1.", false, true),
                                SpanSpec.ListRow(middle, last, 0, kind, "2.", false, true),
                                SpanSpec.ListRow(last, body.length, 0, kind, "3.", false, true),
                            ))), 0L))
                        committedFrame(view)
                        assertTrue(view.isHardwareAccelerated)
                        assertNull(view.engine)
                        assertEquals(body + TextFirstEditText.END_SENTINEL, view.text.toString())
                        assertEquals(last, view.layout.getLineStart(2))
                        val tail = view.editableText.getSpans(last, view.length(), TfList::class.java)
                            .single { view.editableText.getSpanStart(it) == last }
                        assertTrue(tail.first)
                        assertEquals(kind, tail.marker)
                        val end = view.editableText.getSpanEnd(tail)
                        assertEquals(if (ending.isEmpty()) TextFirstEditText.END_SENTINEL else ending,
                            view.editableText.subSequence(last, end).toString())
                        for (row in 0..2) assertEquals(if (rtl) -1 else 1, view.layout.getParagraphDirection(row))
                    }
                    suspend fun selection(start: Int, end: Int, rows: Set<Int>) {
                        Selection.setSelection(view.editableText, start, end)
                        assertEquals(end.coerceAtMost(view.length() - 1), view.selectionEnd)
                        committedFrame(view)
                        val shot = copyViewPixels(view)
                        try {
                            for (row in 0..2) {
                                val y = view.totalPaddingTop + view.layout.getLineTop(row) + view.style.dp(2f).toInt()
                                val dir = view.layout.getParagraphDirection(row)
                                val edge = view.totalPaddingLeft + view.layout.getPrimaryHorizontal(view.layout.getLineStart(row)).toInt()
                                val marker = view.totalPaddingLeft + if (dir > 0) 1 else view.layout.width - 2
                                val background = shot.getPixel(1, y)
                                val body = shot.getPixel(edge + dir * 4, y)
                                if (row in rows) assertNotEquals("native empty-row selection exists", background, body)
                                assertEquals("$kind rtl$rtl selection$start..$end row$row",
                                    if (row in rows) body else background, shot.getPixel(marker, y))
                            }
                        } finally { shot.recycle() }
                    }
                    install(newline)
                    selection(0, middle, setOf(0))
                    selection(middle, 0, setOf(0))
                    selection(last, last + newline.length, setOf(2))
                    selection(last + newline.length, last, setOf(2))
                    selection(middle, last, setOf(1)) // The following empty row is not selected.
                    selection(last, last, emptySet())
                    selection(last + newline.length, last + newline.length, emptySet())
                    if (newline.length == 2) selection(0, 1, emptySet()) // The LF itself is not selected.
                    install("")
                    selection(0, last, setOf(0, 1))
                    selection(0, view.length(), setOf(0, 1)) // Native selection clamps out the sentinel.
                    selection(last, last, emptySet())
                }
            }
        } finally {
            withContext(Dispatchers.Main) { controller.dispose() }
            scenario.close()
            root.deleteRecursively()
        }
    }

    private suspend fun committedFrame(view: android.view.View) {
        try {
            withTimeout(5_000L) {
                suspendCancellableCoroutine<Unit> { done ->
                    view.viewTreeObserver.registerFrameCommitCallback { if (done.isActive) done.resume(Unit) }
                    view.invalidate()
                }
            }
        } catch (error: TimeoutCancellationException) {
            throw AssertionError("No committed frame: attached=${view.isAttachedToWindow}, hardware=${view.isHardwareAccelerated}, size=${view.width}x${view.height}, window=${view.windowVisibility}, focus=${view.hasWindowFocus()}", error)
        }
    }
}
