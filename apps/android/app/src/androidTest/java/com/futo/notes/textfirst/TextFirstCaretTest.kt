package com.futo.notes.textfirst

import android.graphics.Bitmap
import android.graphics.Rect
import android.os.Handler
import android.os.Looper
import android.text.Selection
import android.view.PixelCopy
import androidx.activity.ComponentActivity
import androidx.test.core.app.ActivityScenario
import androidx.test.filters.SdkSuppress
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.util.UUID
import kotlin.coroutines.resume
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.junit.Assert.*
import org.junit.Test
import uniffi.futo_notes_ffi.EditorBlockCommand
import uniffi.futo_notes_ffi.NoteStore

/** The caret draws on top of a line's block background: an opaque code background must not cover it. */
class TextFirstCaretTest {
    @Test fun caretShowsOnAnEmptyPlainLine() = shows("text\n", null)
    @Test fun caretShowsOnAnEmptyCodeLine() = shows("text\n", EditorBlockCommand.CodeBlock)
    @Test fun caretShowsOnAnEmptyQuotedCodeLine() = shows("text\n", EditorBlockCommand.CodeBlock, quoted = true)
    @Test fun caretShowsOnAnEmptyQuoteLine() = shows("text\n", EditorBlockCommand.Quote)

    /** Hardware Layout caches span drawing separately from the native selection path. */
    @SdkSuppress(minSdkVersion = 29)
    @Test fun listMarkersFollowNativeSelectionWithoutATextChange() = runBlocking {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val root = File(context.cacheDir, "marker-selection-${UUID.randomUUID()}").apply { check(mkdirs()) }
        val scenario = ActivityScenario.launch(ComponentActivity::class.java)
        val store = NoteStore(root.path)
        lateinit var controller: TextFirstController
        try {
            val sources = listOf("- Dispatch\n- Archive\n- File", "1. Dispatch\n2. Archive\n3. File", "- [ ] Dispatch\n- [ ] Archive\n- [ ] File", "99. Dispatch\n100. Archive\n101. File")
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
                    val x = view.totalPaddingLeft + 1
                    val ys = (0..2).map { view.totalPaddingTop + view.layout.getLineTop(it) + view.style.dp(2f).toInt() }
                    suspend fun assertMarkers(start: Int, end: Int, selectedRows: Set<Int>) {
                        val shot = onScreen(view)
                        try {
                            for (row in ys.indices) {
                                val bodyX = view.totalPaddingLeft + view.layout.getPrimaryHorizontal(view.layout.getLineStart(row)).toInt() + 1
                                val body = shot.getPixel(bodyX, ys[row])
                                val background = shot.getPixel(1, ys[row])
                                if (row in selectedRows) assertNotEquals("the native body selection is drawn", background, body)
                                // Compare one frame: window transitions can change its overall brightness.
                                val expected = if (row in selectedRows) body else background
                                assertEquals("${sources[i].substringBefore('\n')}: selection $start..$end, marker row $row", expected, shot.getPixel(x, ys[row]))
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

    /** The blank line above a heading is drawn half height, but its caret is as tall as the one on a line of text. */
    @Test fun caretOnABlankLineIsAsTallAsOnALineOfText() = runBlocking {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val root = File(context.cacheDir, "caret-${UUID.randomUUID()}").apply { check(mkdirs()) }
        val scenario = ActivityScenario.launch(ComponentActivity::class.java)
        val store = NoteStore(root.path)
        lateinit var controller: TextFirstController
        try {
            store.createNote("n", "", "an\n\n# Ho\n")
            withContext(Dispatchers.Main) {
                suspendCancellableCoroutine<Unit> { done ->
                    scenario.onActivity { activity ->
                        controller = createTextFirstController(activity, { store }, root)
                        activity.setContentView(controller.view)
                        controller.open("n") { assertNull(it); done.resume(Unit) }
                    }
                }
                val view = controller.view
                view.isFocusableInTouchMode = true; view.requestFocusFromTouch()
                // The empty last line is a full line: nothing around its caret but blank space.
                val text = caretHeight(controller, view.length() - 1)
                val blank = caretHeight(controller, 3)
                assertTrue("a full line has a caret", text > 0)
                assertTrue("the caret on a blank line is $blank px tall, on a full line $text", blank >= text * 9 / 10)
            }
        } finally {
            withContext(Dispatchers.Main) { controller.discard(); controller.dispose() }
            scenario.close()
            store.destroy()
            root.deleteRecursively()
        }
    }

    /** The tallest caret seen with the selection at [offset], across more than one blink period; 0 if it never drew. */
    private suspend fun caretHeight(controller: TextFirstController, offset: Int): Int {
        val view = controller.view
        controller.select(offset)
        delay(300L)
        val layout = view.layout!!
        val line = layout.getLineForOffset(offset)
        val y = (layout.getLineTop(line) + layout.getLineBottom(line)) / 2 + view.totalPaddingTop
        val caretX = view.totalPaddingLeft + layout.getPrimaryHorizontal(offset).toInt()
        var tallest = 0
        repeat(24) {
            val shot = onScreen(view)
            val background = shot.getPixel(caretX + 40, y)
            for (x in caretX - 1..caretX + 4) {
                if (shot.getPixel(x, y) == background) continue
                var up = y
                while (up > 0 && shot.getPixel(x, up - 1) != background) up--
                var down = y
                while (down < shot.height - 1 && shot.getPixel(x, down + 1) != background) down++
                tallest = maxOf(tallest, down - up + 1)
            }
            if (tallest == 0) delay(60L)
        }
        return tallest
    }

    private fun shows(raw: String, command: EditorBlockCommand?, quoted: Boolean = false) = runBlocking {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val root = File(context.cacheDir, "caret-${UUID.randomUUID()}").apply { check(mkdirs()) }
        val scenario = ActivityScenario.launch(ComponentActivity::class.java)
        val store = NoteStore(root.path)
        lateinit var controller: TextFirstController
        try {
            store.createNote("n", "", raw)
            withContext(Dispatchers.Main) {
                suspendCancellableCoroutine<Unit> { done ->
                    scenario.onActivity { activity ->
                        controller = createTextFirstController(activity, { store }, root)
                        activity.setContentView(controller.view)
                        controller.open("n") { assertNull(it); done.resume(Unit) }
                    }
                }
                val view = controller.view
                view.isFocusableInTouchMode = true; view.requestFocusFromTouch()
                controller.select(raw.length)
                delay(300L)
                if (quoted) controller.block(EditorBlockCommand.Quote)
                if (command != null) controller.block(command)
                delay(500L)
                val layout = view.layout!!
                val line = layout.getLineForOffset(view.selectionStart)
                val top = layout.getLineTop(line) + view.totalPaddingTop
                val bottom = layout.getLineBottom(line) + view.totalPaddingTop
                val caretX = view.totalPaddingLeft + layout.getPrimaryHorizontal(view.selectionStart).toInt()
                var drawn = false
                // The caret blinks: look across more than one blink period.
                repeat(24) {
                    if (!drawn) {
                        val shot = onScreen(view)
                        drawn = caretColumn(shot, caretX, top, bottom)
                        if (!drawn) delay(60L)
                    }
                }
                assertTrue("the caret draws on the empty ${if (quoted) "quoted " else ""}${command?.let { it::class.simpleName } ?: "plain"} line", drawn)
            }
        } finally {
            withContext(Dispatchers.Main) { controller.discard(); controller.dispose() }
            scenario.close()
            store.destroy()
            root.deleteRecursively()
        }
    }

    /** The view as the window composes it (a hardware draw, so the caret is in it), by PixelCopy. */
    private suspend fun onScreen(view: android.view.View): Bitmap = suspendCancellableCoroutine { done ->
        val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
        val at = IntArray(2).also(view::getLocationInWindow)
        val window = (view.context as android.app.Activity).window
        PixelCopy.request(window, Rect(at[0], at[1], at[0] + view.width, at[1] + view.height), bitmap, { status ->
            if (status == PixelCopy.SUCCESS) done.resume(bitmap) else {
                bitmap.recycle()
                done.resumeWith(Result.failure(AssertionError("PixelCopy failed: $status")))
            }
        }, Handler(Looper.getMainLooper()))
    }

    /** True when a pixel at the caret's column differs from the line's plain background (the pixel a little to its right, on the same empty line). */
    private fun caretColumn(bitmap: Bitmap, caretX: Int, top: Int, bottom: Int): Boolean {
        val y = (top + bottom) / 2
        val background = bitmap.getPixel(caretX + 40, y)
        for (x in caretX - 1..caretX + 4) if (bitmap.getPixel(x, y) != background) return true
        return false
    }
}
