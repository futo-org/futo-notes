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
        val x = view.width / 2f
        val y = view.totalPaddingTop + view.layout.getLineTop(0) + view.style.codeHeaderHeight / 2f
        val down = SystemClock.uptimeMillis()
        for ((action, time) in listOf(MotionEvent.ACTION_DOWN to down, MotionEvent.ACTION_UP to down + 40L)) {
            val event = MotionEvent.obtain(down, time, action, x, y, 0)
            event.source = InputDevice.SOURCE_TOUCHSCREEN
            try { view.dispatchTouchEvent(event) } finally { event.recycle() }
        }
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
}
