package com.futo.notes.textfirst

import android.graphics.Bitmap
import android.graphics.Rect
import android.os.Handler
import android.os.Looper
import android.view.PixelCopy
import androidx.activity.ComponentActivity
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.util.UUID
import kotlin.coroutines.resume
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
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
        PixelCopy.request(window, Rect(at[0], at[1], at[0] + view.width, at[1] + view.height), bitmap, { done.resume(bitmap) }, Handler(Looper.getMainLooper()))
    }

    /** True when a pixel at the caret's column differs from the line's plain background (the pixel a little to its right, on the same empty line). */
    private fun caretColumn(bitmap: Bitmap, caretX: Int, top: Int, bottom: Int): Boolean {
        val y = (top + bottom) / 2
        val background = bitmap.getPixel(caretX + 40, y)
        for (x in caretX - 1..caretX + 4) if (bitmap.getPixel(x, y) != background) return true
        return false
    }
}
