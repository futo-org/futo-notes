package com.futo.notes.textfirst

import android.text.Layout
import android.text.StaticLayout
import android.text.TextPaint
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

/**
 * After the engine edits a note, the attached DynamicLayout must hold exactly the
 * lines a layout built from scratch over the same text and spans would: every
 * line's start, top and bottom. A block-height change (a heading toggled, a quote
 * added) must shift everything below it, not only the lines in the edit's window.
 */
class TextFirstLayoutReflowTest {
    private val note = "> # Welcome to FUTO Notes\n\n" +
        "FUTO Notes keeps everything as plain Markdown files on your device. There's no account to create and nothing to sign in to \u2014 your notes are just files you own.\n\n" +
        "## Getting started\n- Open a note to edit it; changes save as you type.\n\n" +
        "## Markdown you can use\n- **Bold**, *italic*, and `inline code`\n- Bulleted and numbered lists\n- [ ] Checklists \u2014 tap a box to toggle it\n- Group notes with #tags, or sort them into folders\n\n" +
        "Feel free to delete this note once you've had a look around.\n"

    @Test fun openedNoteMatchesAFreshLayout() = withController(note) { controller ->
        assertMatchesFresh("after open", controller.view)
        assertDrawnAsFresh("after open", controller.view)
    }

    @Test fun togglingH1OnTheFirstQuotedLineReflowsEverythingBelow() = toggle(note, 0, EditorBlockCommand.ToggleHeading(1u))
    @Test fun togglingH2OnTheFirstQuotedLineReflowsEverythingBelow() = toggle(note, 0, EditorBlockCommand.ToggleHeading(2u))
    @Test fun togglingH3OnTheFirstQuotedLineReflowsEverythingBelow() = toggle(note, 0, EditorBlockCommand.ToggleHeading(3u))
    @Test fun togglingQuoteOnTheFirstLineReflowsEverythingBelow() = toggle(note, 0, EditorBlockCommand.Quote)
    @Test fun togglingAHeadingInTheMiddleReflowsEverythingBelow() =
        toggle(note, note.indexOf("FUTO Notes keeps"), EditorBlockCommand.ToggleHeading(1u))
    @Test fun togglingAListInTheMiddleReflowsEverythingBelow() =
        toggle(note, note.indexOf("Feel free"), EditorBlockCommand.BulletList)

    private fun toggle(raw: String, at: Int, command: EditorBlockCommand) = withController(raw) { controller ->
        val view = controller.view
        assertTrue(controller.selectDisplayRange(at))
        assertMatchesFresh("before $command", view)
        assertDrawnAsFresh("before $command", view)
        controller.block(command)
        controller.sourceText() // Queue barrier: the command and its UI update have completed.
        delay(300L)
        assertMatchesFresh("after $command", view)
        assertDrawnAsFresh("after $command", view)
        controller.block(command)
        controller.sourceText()
        delay(300L)
        assertMatchesFresh("after $command again", view)
        assertDrawnAsFresh("after $command again", view)
    }

    /**
     * What is on screen must be what a clean redraw shows. DynamicLayout reuses a
     * cached display list per block of lines and, when an edit keeps the line count,
     * does not move the blocks below it: their lines keep the screen position they
     * had before the edit even though the layout holds the new one.
     */
    private suspend fun assertDrawnAsFresh(label: String, view: TextFirstEditText) {
        val shown = capture(view)
        view.setShadowLayer(0f, 0f, 0f, 0) // Invalidates every cached display list, changes no pixel.
        delay(300L)
        val clean = capture(view)
        if (shown.sameAs(clean)) return
        var firstRow = -1
        search@ for (y in 0 until shown.height) for (x in 0 until shown.width) {
            if (shown.getPixel(x, y) != clean.getPixel(x, y)) { firstRow = y; break@search }
        }
        fail("$label: the screen differs from a clean redraw, first differing pixel row $firstRow (view-relative y; layout line tops ${(0 until view.layout.lineCount).map { view.layout.getLineTop(it) + view.totalPaddingTop - view.scrollY }})")
    }

    private suspend fun capture(view: TextFirstEditText): android.graphics.Bitmap = suspendCancellableCoroutine { done ->
        val at = IntArray(2).also { view.getLocationInWindow(it) }
        val bitmap = android.graphics.Bitmap.createBitmap(view.width, view.height, android.graphics.Bitmap.Config.ARGB_8888)
        val window = (view.context as android.app.Activity).window
        android.view.PixelCopy.request(
            window, android.graphics.Rect(at[0], at[1], at[0] + view.width, at[1] + view.height), bitmap,
            { result -> check(result == android.view.PixelCopy.SUCCESS) { "PixelCopy $result" }; done.resume(bitmap) },
            android.os.Handler(android.os.Looper.getMainLooper()),
        )
    }

    private fun assertMatchesFresh(label: String, view: TextFirstEditText) {
        val live = view.layout
        val text = view.editableText
        val fresh = StaticLayout.Builder.obtain(text, 0, text.length, TextPaint(view.paint), live.width)
            .setLineSpacing(view.lineSpacingExtra, view.lineSpacingMultiplier)
            .setIncludePad(view.includeFontPadding)
            .setBreakStrategy(view.breakStrategy)
            .setHyphenationFrequency(view.hyphenationFrequency)
            .setUseLineSpacingFromFallbacks(view.isFallbackLineSpacing)
            .build()
        val diffs = ArrayList<String>()
        if (live.lineCount != fresh.lineCount) diffs += "lineCount live=${live.lineCount} fresh=${fresh.lineCount}"
        for (i in 0 until minOf(live.lineCount, fresh.lineCount)) {
            val l = Triple(live.getLineStart(i), live.getLineTop(i), live.getLineBottom(i))
            val f = Triple(fresh.getLineStart(i), fresh.getLineTop(i), fresh.getLineBottom(i))
            if (l != f) diffs += "line $i (start,top,bottom) live=$l fresh=$f  \"${text.substring(fresh.getLineStart(i), minOf(fresh.getLineEnd(i), fresh.getLineStart(i) + 24)).replace("\n", "\\n")}\""
        }
        assertTrue("$label: live layout differs from a fresh one:\n" + diffs.joinToString("\n"), diffs.isEmpty())
    }

    private fun withController(raw: String, exercise: suspend (TextFirstController) -> Unit) = runBlocking {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val root = File(context.cacheDir, "layout-reflow-${UUID.randomUUID()}").apply { check(mkdirs()) }
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
                controller.sourceText()
                delay(500L)
                exercise(controller)
            }
        } finally {
            withContext(Dispatchers.Main) { controller.discard(); controller.dispose() }
            scenario.close()
            store.destroy()
            root.deleteRecursively()
        }
    }
}
