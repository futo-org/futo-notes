package com.futo.notes.textfirst

import android.os.SystemClock
import android.view.InputDevice
import android.view.MotionEvent
import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Test

/** A fenced block as one object (fenced-code.md): a press on its header selects it, and the keyboard keeps it selected. */
class TextFirstCodeBlockTest {
    private val raw = "```js\nconst a = 1\nconst b = 2\n```\n\nafter"
    private val code = "const a = 1\nconst b = 2"

    private suspend fun tapHeader(view: TextFirstEditText) {
        withTimeout(5_000) { while (view.layout == null || view.editableText.getSpans(0, 1, TfCodeBlock::class.java).isEmpty()) delay(20) }
        tapNoteAt(view, view.width / 2f, view.totalPaddingTop + view.layout.getLineTop(0) + view.style.codeHeaderHeight / 2f)
    }

    private suspend fun awaitSelectedBlock(view: TextFirstEditText) {
        withTimeout(5_000) { while (view.selectedCodeBlock == null) delay(20) }
    }

    @Test fun aHeaderTapSelectsTheBlockAndTheKeyboardsEchoKeepsIt() = textFirstSession(raw) { c ->
        val view = c.view
        tapHeader(view)
        awaitSelectedBlock(view)
        assertEquals(0 to code.length, view.selectionStart to view.selectionEnd)
        textFirstIme(c) { setSelection(0, code.length) }
        c.sourceText()
        assertEquals(0 to code.length, view.selectedCodeBlock)
        assertEquals(0 to code.length, view.selectionStart to view.selectionEnd)
    }

    /** Gboard types over a selection as one batch: collapse to its end, delete back over it, commit the letter. */
    @Test fun typingOverTheSelectedBlockReplacesItAsOneUndoStep() = textFirstSession(raw) { c ->
        val view = c.view
        tapHeader(view)
        awaitSelectedBlock(view)
        textFirstIme(c) {
            beginBatchEdit()
            setSelection(code.length, code.length)
            deleteSurroundingText(code.length, 0)
            commitText("x", 1)
            endBatchEdit()
        }
        assertEquals("x\n\nafter", c.sourceText())
        c.undo()
        assertEquals(raw, c.sourceText())
        awaitSelectedBlock(view)
        assertEquals(0 to code.length, view.selectionStart to view.selectionEnd)
    }

    @Test fun aTapUnderABlockThatEndsTheNoteOpensALineAndRaisesTheKeyboard() = textFirstSession("```js\nconst a = 1\n```") { c ->
        val view = c.view
        view.isFocusableInTouchMode = true
        view.hideKeyboard()
        withTimeout(5_000) { while (view.layout == null || view.editableText.getSpans(0, 1, TfCodeBlock::class.java).isEmpty()) delay(20) }
        val below = view.totalPaddingTop + view.layout.height + view.style.dp(40f)
        withTimeout(5_000) { while (view.codeChrome.targetAt(view.width / 2f, below - view.totalPaddingTop) == null) delay(20) }
        tapNoteAt(view, view.width / 2f, below)
        assertEquals("```js\nconst a = 1\n```\n", c.sourceText())
        assertEquals(view.length() - TextFirstEditText.END_SENTINEL.length, view.selectionStart)
        withTimeout(5_000) {
            while (androidx.core.view.ViewCompat.getRootWindowInsets(view)?.isVisible(androidx.core.view.WindowInsetsCompat.Type.ime()) != true) delay(50)
        }
    }

    @Test fun aPressAboveABlockThatOpensTheNoteDoesNothing() = textFirstSession(raw) { c ->
        val view = c.view
        view.isFocusableInTouchMode = true
        view.hideKeyboard()
        withTimeout(5_000) { while (view.layout == null || view.editableText.getSpans(0, 1, TfCodeBlock::class.java).isEmpty()) delay(20) }
        withTimeout(5_000) { while (view.codeChrome.targetAt(view.width / 2f, -1f) == null) delay(20) }
        val focused = view.isFocused
        val selection = view.selectionStart to view.selectionEnd
        tapNoteAt(view, view.width / 2f, view.totalPaddingTop - 2f)
        c.sourceText()
        assertEquals(focused, view.isFocused)
        assertEquals(selection, view.selectionStart to view.selectionEnd)
    }

    @Test fun aTapInsideAnEmptySelectedBlockLetsTheNextLetterTypeIntoIt() = textFirstSession("intro\n\n```js\n\n```\n\nafter") { c ->
        val view = c.view
        val code = view.editableText.indexOf("\n\n") + 2
        withTimeout(5_000) { while (view.layout == null || view.editableText.getSpans(code, code + 1, TfCodeBlock::class.java).isEmpty()) delay(20) }
        val line = view.layout.getLineForOffset(code)
        tapNoteAt(view, view.width / 2f, view.totalPaddingTop + view.layout.getLineTop(line) + view.style.codeHeaderHeight / 2f)
        awaitSelectedBlock(view)
        // Past the double-tap window, so this reads as a second, separate tap.
        delay(500)
        tapNoteAt(view, view.width / 2f, view.totalPaddingTop + view.layout.getLineBaseline(line).toFloat())
        withTimeout(5_000) { while (view.selectedCodeBlock != null) delay(20) }
        textFirstIme(c) { commitText("x", 1) }
        assertEquals("intro\n\n```js\nx\n```\n\nafter", c.sourceText())
    }

    /**
     * Mason's report: "add a line below" rendered strangely. !300's page (job13/report3): between two
     * touching blocks the label's line box starts 2 px (0.2 skirt) above the upper card's skirt and
     * is one skirt tall, inside the card; a press from there down to the lower card opens the line.
     */
    @Test fun addALineBelowSitsInTheSkirtWhereThreeHundredPutIt() = textFirstSession("```js\nconst a = 1\n```\n```rust\nlet b = 2;\n```\n\nend") { c ->
        val view = c.view
        view.isFocusableInTouchMode = true
        view.requestFocus()
        textFirstIme(c) { setSelection(3, 3) }
        c.sourceText()
        val lower = view.editableText.indexOf("let b")
        withTimeout(5_000) { while (view.codeChrome.areaOf(0, CodeBlockAction.OPEN_LINE_BELOW) == null || view.codeChrome.areaOf(lower, CodeBlockAction.SELECT_BLOCK) == null) delay(20) }
        val press = view.codeChrome.areaOf(0, CodeBlockAction.OPEN_LINE_BELOW)!!
        val label = view.codeChrome.belowLabelBox!!
        val nextCard = view.codeChrome.areaOf(lower, CodeBlockAction.SELECT_BLOCK)!!.top
        val look = view.style
        val skirtTop = nextCard - look.codeBlockGap - look.codeSkirt
        assertEquals(skirtTop - look.codeSkirt * 0.2f, label.top, 1f)
        assertEquals(look.codeSkirt, label.height(), 1f)
        assertEquals(label.top, press.top, 1f)
        assertEquals(nextCard, press.bottom, 1f)
    }

    /** Verifier run 1, items 1 and 2: the gap between touching blocks opens a line even with nothing active, and the new line is outside every block. */
    @Test fun theGapBetweenTouchingBlocksOpensALineAndLeavesNoBlockActive() = textFirstSession("```js\nconst a = 1\n```\n```rust\nlet b = 2;\n```\n\nend") { c ->
        val view = c.view
        view.isFocusableInTouchMode = true
        val lower = view.editableText.indexOf("let b")
        withTimeout(5_000) { while (view.codeChrome.areaOf(lower, CodeBlockAction.SELECT_BLOCK) == null) delay(20) }
        val nextCard = view.codeChrome.areaOf(lower, CodeBlockAction.SELECT_BLOCK)!!.top
        tapNoteAt(view, view.width / 2f, view.totalPaddingTop - view.scrollY + nextCard - view.style.codeBlockGap / 2f)
        assertEquals("```js\nconst a = 1\n```\n\n```rust\nlet b = 2;\n```\n\nend", c.sourceText())
        delay(300)
        assertEquals("a block still shows \"add a line above\" with the caret outside it", null, view.codeChrome.areaOf(0, CodeBlockAction.OPEN_LINE_ABOVE))
        assertEquals(null, view.codeChrome.areaOf(lower, CodeBlockAction.OPEN_LINE_ABOVE))
    }

    /**
     * Verifier run 3, G: a tap on a block's last line put the caret's handle over "add a line below", and
     * the handle's window took the next tap there. Real input, so the handle's window is in the way as on a phone.
     */
    @Test fun aTapOnAddALineBelowOverTheCaretsHandleOpensTheLine() = textFirstSession("```js\nconst a = 1\n```\n```rust\nlet b = 2;\n```\n\nend") { c ->
        val view = c.view
        view.isFocusableInTouchMode = true
        withTimeout(5_000) { while (view.layout == null) delay(20) }
        val instrumentation = androidx.test.platform.app.InstrumentationRegistry.getInstrumentation()
        fun injectTap(x: Float, y: Float) {
            val down = SystemClock.uptimeMillis()
            for ((action, time) in listOf(MotionEvent.ACTION_DOWN to down, MotionEvent.ACTION_UP to down + 60L)) {
                val event = MotionEvent.obtain(down, time, action, x, y, 0)
                event.source = InputDevice.SOURCE_TOUCHSCREEN
                try { instrumentation.sendPointerSync(event) } finally { event.recycle() }
            }
        }
        // Injected through the window manager, off the main thread that handles it, so the handle's window is hit as on a phone.
        suspend fun screenTap(x: Float, y: Float) {
            val onScreen = IntArray(2).also(view::getLocationOnScreen)
            kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) { injectTap(onScreen[0] + x, onScreen[1] + y) }
        }
        val l = view.layout
        val lastLine = l.getLineForOffset(view.editableText.indexOf("const a"))
        val caretX = view.totalPaddingLeft + l.getLineRight(lastLine) - 4f
        screenTap(caretX, view.totalPaddingTop - view.scrollY + (l.getLineTop(lastLine) + l.getLineBottom(lastLine)) / 2f)
        suspend fun awaitThat(what: String, done: () -> Boolean) {
            val until = SystemClock.uptimeMillis() + 5_000
            while (!done()) { if (SystemClock.uptimeMillis() > until) throw AssertionError(what); delay(20) }
        }
        awaitThat("the tap put no caret at the end of the line (at ${view.selectionEnd})") { view.selectionEnd == view.editableText.indexOf("const a") + "const a = 1".length }
        awaitThat("no \"add a line below\"") { view.codeChrome.belowLabelBox != null }
        delay(500)
        // The strip under the label, down to the next card: where the handle hangs (verifier run 3, G: y 790).
        val press = view.codeChrome.areaOf(0, CodeBlockAction.OPEN_LINE_BELOW)!!
        val label = view.codeChrome.belowLabelBox!!
        screenTap(view.totalPaddingLeft + view.layout.getPrimaryHorizontal(view.selectionEnd), view.totalPaddingTop - view.scrollY + (label.bottom + press.bottom) / 2f)
        delay(1_000)
        assertEquals("```js\nconst a = 1\n```\n\n```rust\nlet b = 2;\n```\n\nend", c.sourceText())
    }
}
