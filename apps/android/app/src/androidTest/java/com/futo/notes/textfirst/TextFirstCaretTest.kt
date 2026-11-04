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
