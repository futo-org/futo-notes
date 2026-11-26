package com.futo.notes.textfirst

import android.graphics.Bitmap
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

    /** An h1 line is two body lines tall; its caret is only as tall as the h1's text and sits on it. */
    @Test fun caretOnAHeadingIsTheHeightOfItsText() = runBlocking {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val root = File(context.cacheDir, "caret-${UUID.randomUUID()}").apply { check(mkdirs()) }
        val scenario = ActivityScenario.launch(ComponentActivity::class.java)
        val store = NoteStore(root.path)
        lateinit var controller: TextFirstController
        try {
            store.createNote("n", "", "# Hi\nbody\n")
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
                val caret = checkNotNull(caretExtent(controller, 2)) { "the caret draws on the h1" }
                val layout = view.layout
                val paint = android.text.TextPaint(view.paint)
                for (span in view.editableText.getSpans(1, 2, android.text.style.MetricAffectingSpan::class.java)) span.updateMeasureState(paint)
                val baseline = view.totalPaddingTop + layout.getLineBaseline(0)
                val seen = android.graphics.Rect().also { paint.getTextBounds("Hg", 0, 2, it) }
                val textTop = baseline + paint.fontMetricsInt.ascent
                val textBottom = baseline + paint.fontMetricsInt.descent
                val lineHeight = layout.getLineBottom(0) - layout.getLineTop(0)
                assertTrue("the h1 line ($lineHeight px) is taller than its text", lineHeight > textBottom - textTop)
                assertEquals("the caret is as tall as the h1's text", (textBottom - textTop).toFloat(), (caret.last - caret.first).toFloat(), 2f)
                // Mason (S23): centred on the letters as seen, as far above the capitals as below the descenders.
                assertEquals("room above the capitals against below the descenders", (baseline + seen.top - caret.first).toFloat(), (caret.last - baseline - seen.bottom).toFloat(), 2f)
            }
        } finally {
            withContext(Dispatchers.Main) { controller.discard(); controller.dispose() }
            scenario.close()
            store.destroy()
            root.deleteRecursively()
        }
    }

    /** Mason (S23): the caret on body text sat high, 20 px above the capitals and 1 px below the descenders. */
    @Test fun caretOnBodyTextIsCentredOnItsLetters() = textFirstSession("Body Hgjp\nnext\n") { c ->
        val view = c.view
        view.isFocusableInTouchMode = true; view.requestFocusFromTouch()
        val caret = checkNotNull(caretExtent(c, 9)) { "the caret draws on the body line" }
        val seen = android.graphics.Rect().also { view.paint.getTextBounds("Hg", 0, 2, it) }
        val baseline = view.totalPaddingTop + view.layout.getLineBaseline(0)
        assertEquals("room above the capitals against below the descenders", (baseline + seen.top - caret.first).toFloat(), (caret.last - baseline - seen.bottom).toFloat(), 2f)
    }

    /**
     * Samsung's Editor (One UI 5, S20 Ultra, crash reports #1856–#1858) copies the caret when it first shows the
     * insertion handle: `getTextCursorDrawable().getConstantState().newDrawable()`. A caret with no constant state
     * crashed the tap that placed it.
     */
    @androidx.test.filters.SdkSuppress(minSdkVersion = 29)
    @Test fun theCaretCanBeCopiedTheWaySamsungsInsertionHandleCopiesIt() = textFirstSession("text\n") { c ->
        val caret = checkNotNull(c.view.textCursorDrawable) { "the note view has a caret drawable" }
        val state = checkNotNull(caret.constantState) { "the caret has a constant state to copy" }
        assertNotNull("the copy is a drawable", state.newDrawable())
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
    private suspend fun caretHeight(controller: TextFirstController, offset: Int): Int =
        caretExtent(controller, offset)?.let { it.last - it.first + 1 } ?: 0

    /** The view rows the tallest caret seen at [offset] covers, across more than one blink period; null if it never drew. */
    private suspend fun caretExtent(controller: TextFirstController, offset: Int): IntRange? {
        val view = controller.view
        controller.select(offset)
        delay(300L)
        val layout = view.layout!!
        val line = layout.getLineForOffset(offset)
        val y = (layout.getLineTop(line) + layout.getLineBottom(line)) / 2 + view.totalPaddingTop
        val caretX = view.totalPaddingLeft + layout.getPrimaryHorizontal(offset).toInt()
        var tallest: IntRange? = null
        repeat(24) {
            val shot = copyViewPixels(view)
            val background = shot.getPixel(caretX + 40, y)
            for (x in caretX - 1..caretX + 4) {
                if (shot.getPixel(x, y) == background) continue
                var up = y
                while (up > 0 && shot.getPixel(x, up - 1) != background) up--
                var down = y
                while (down < shot.height - 1 && shot.getPixel(x, down + 1) != background) down++
                if (tallest == null || down - up > tallest!!.last - tallest!!.first) tallest = up..down
            }
            if (tallest == null) delay(60L)
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
                // The text's own row: a code block's line box also holds its header and skirt (area 2: !300's line height).
                val baseline = layout.getLineBaseline(line) + view.totalPaddingTop
                val top = baseline - view.textSize.toInt()
                val bottom = baseline
                val caretX = view.totalPaddingLeft + layout.getPrimaryHorizontal(view.selectionStart).toInt()
                var drawn = false
                // The caret blinks: look across more than one blink period.
                repeat(24) {
                    if (!drawn) {
                        val shot = copyViewPixels(view)
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

    /** True when a pixel at the caret's column differs from the line's plain background (the pixel a little to its right, on the same empty line). */
    private fun caretColumn(bitmap: Bitmap, caretX: Int, top: Int, bottom: Int): Boolean {
        val y = (top + bottom) / 2
        val background = bitmap.getPixel(caretX + 40, y)
        for (x in caretX - 1..caretX + 4) if (bitmap.getPixel(x, y) != background) return true
        return false
    }
}
