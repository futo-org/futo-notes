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

/** A list item's marker is its first character: a selection tints it exactly when it covers it. */
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
                    // Inside the band the selection is drawn on, near its top.
                    val ys = (0..2).map { view.totalPaddingTop + view.overlayBand(view.layout, view.editableText, it).first.toInt() + view.style.dp(2f).toInt() }
                    // A marker is its item's first character: tinted exactly when the selection covers it.
                    suspend fun assertMarkers(start: Int, end: Int) {
                        val low = minOf(start, end)
                        val high = maxOf(start, end)
                        val shot = copyViewPixels(view)
                        try {
                            for (row in ys.indices) {
                                val dir = view.layout.getParagraphDirection(row)
                                val at = view.layout.getLineStart(row)
                                val bodyEdge = view.totalPaddingLeft + view.layout.getPrimaryHorizontal(at + 1).toInt()
                                val markerX = view.totalPaddingLeft + if (dir > 0) 1 else view.layout.width - 2
                                val background = shot.getPixel(1, ys[row])
                                val markerSelected = at in low until high
                                val textSelected = at + 1 in low until high
                                val body = shot.getPixel(bodyEdge + dir * 4, ys[row])
                                if (textSelected) assertNotEquals("the body selection is drawn", background, body)
                                val marker = shot.getPixel(markerX, ys[row])
                                val what = "${sources[i].substringBefore('\n')}: selection $start..$end, marker row $row"
                                if (markerSelected) assertNotEquals(what, background, marker) else assertEquals(what, background, marker)
                                // The marker's tint meets the text's without painting the translucent highlight twice.
                                if (markerSelected && textSelected) for (edgeX in bodyEdge - 1..bodyEdge + 1) {
                                    assertEquals("selection $start..$end, row $row, body edge $edgeX", body, shot.getPixel(edgeX, ys[row]))
                                }
                            }
                        } finally { shot.recycle() }
                    }
                    suspend fun selection(start: Int, end: Int) {
                        Selection.setSelection(view.editableText, start, end)
                        committedFrame(view)
                        assertMarkers(start, end)
                    }
                    val rows = (0..2).map { view.layout.getLineStart(it) }
                    val third = rows[2] + view.editableText.substring(rows[2]).indexOf('\n')
                    selection(0, third)
                    selection(rows[0] + 3, rows[0] + 3)
                    selection(third, 0)
                    selection(rows[0] + 1, rows[0] + 4)
                    selection(rows[0], rows[0] + 1)
                    selection(rows[1], rows[2] - 1)
                    selection(rows[2] + 1, third)
                    selection(0, third)
                    view.scrollTo(0, view.layout.height - view.height)
                    committedFrame(view)
                    assertTrue("selected markers were scrolled off screen", view.scrollY > view.layout.getLineBottom(2))
                    val last = view.length() - 1
                    Selection.setSelection(view.editableText, last)
                    committedFrame(view)
                    view.scrollTo(0, 0)
                    committedFrame(view)
                    assertMarkers(last, last)
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

    /** An empty item shows only its marker unit: the marker is tinted when the selection covers it, not for its line break alone. */
    @SdkSuppress(minSdkVersion = 29)
    @Test fun anEmptyItemsMarkerIsTintedOnlyWhenSelected() = runBlocking {
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
                    val middle = 1 + newline.length
                    val last = middle + 1 + label.length + newline.length
                    val body = "\uFFFC" + newline + "\uFFFC" + label + newline + "\uFFFC"
                    view.apply(UiUpdate(seq++, body, emptyList(), 0, 0, -1, -1,
                        listOf(StyleWindow(0, body.length, listOf(
                            SpanSpec.ListRow(0, middle, 0, kind, "1.", false, true),
                            SpanSpec.ListItemMarker(0, 1, 0, kind, "1.", false),
                            SpanSpec.ListRow(middle, last, 0, kind, "2.", false, true),
                            SpanSpec.ListItemMarker(middle, middle + 1, 0, kind, "2.", false),
                            SpanSpec.ListRow(last, body.length, 0, kind, "3.", false, true),
                            SpanSpec.ListItemMarker(last, last + 1, 0, kind, "3.", false),
                        ))), 0L))
                    committedFrame(view)
                    assertEquals(body.replace('\uFFFC', '\u00A0') + TextFirstEditText.END_SENTINEL, view.text.toString())
                    for (row in 0..2) assertEquals(if (rtl) -1 else 1, view.layout.getParagraphDirection(row))
                    suspend fun selection(start: Int, end: Int, rows: Set<Int>) {
                        Selection.setSelection(view.editableText, start, end)
                        committedFrame(view)
                        val shot = copyViewPixels(view)
                        try {
                            for (row in 0..2) {
                                val y = view.totalPaddingTop + view.overlayBand(view.layout, view.editableText, row).first.toInt() + view.style.dp(2f).toInt()
                                val marker = view.totalPaddingLeft + if (view.layout.getParagraphDirection(row) > 0) 1 else view.layout.width - 2
                                val what = "$kind rtl$rtl selection$start..$end row$row"
                                if (row in rows) assertNotEquals(what, shot.getPixel(1, y), shot.getPixel(marker, y))
                                else assertEquals(what, shot.getPixel(1, y), shot.getPixel(marker, y))
                            }
                        } finally { shot.recycle() }
                    }
                    selection(0, 1, setOf(0))
                    selection(1, middle, emptySet()) // Its line break alone.
                    selection(0, middle, setOf(0))
                    selection(middle + 1, last, emptySet()) // The second item's text and break, not its marker.
                    selection(last, last + 1, setOf(2))
                    selection(0, view.length(), setOf(0, 1, 2)) // Native selection clamps out the sentinel.
                    selection(last + 1, last + 1, emptySet())
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
