package com.futo.notes.textfirst

import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Mason (job 11 A): a hold on a block's header selects it whole and shows Cut, Copy and Paste; a tap selects it alone. */
class TextFirstCodeBlockCalloutTest {
    private val note = "intro\n\n```js name:short.js\nconst a = 1\nconst b = 2\n```\n\nafter"

    private suspend fun header(view: TextFirstEditText): Pair<Float, Float> {
        val start = view.editableText.indexOf("const a")
        withTimeout(5_000) { while (view.codeChrome.areaOf(start, CodeBlockAction.SELECT_BLOCK) == null) delay(20) }
        val area = view.codeChrome.areaOf(start, CodeBlockAction.SELECT_BLOCK)!!
        // The header's right end: the name and the language chip are fields of their own.
        return (view.totalPaddingLeft + area.left + area.width() * 0.6f) to (view.totalPaddingTop - view.scrollY + area.centerY())
    }

    private suspend fun awaitCallout(view: TextFirstEditText) {
        withTimeout(5_000) { while (view.selectedCodeBlock == null || !view.codeTouch.callout.isShowing) delay(20) }
    }

    @Test fun aHoldOnTheHeaderSelectsTheBlockWithItsCallout() = textFirstSession(note) { c ->
        val view = c.view
        val (x, y) = header(view)
        holdNoteAt(view, x, y)
        awaitCallout(view)
        val e = view.editableText
        assertEquals(e.indexOf("const a") to e.indexOf("const b") + "const b = 2".length, view.selectedCodeBlock)
    }

    @Test fun aTapOnTheProseEndsTheBlockSelectionAndItsCallout() = textFirstSession(note) { c ->
        val view = c.view
        val (x, y) = header(view)
        holdNoteAt(view, x, y)
        awaitCallout(view)
        tapNoteAt(view, view.totalPaddingLeft + 10f, view.totalPaddingTop - view.scrollY + view.layout.getLineBottom(0) / 2f)
        withTimeout(5_000) { while (view.codeTouch.callout.isShowing || view.selectedCodeBlock != null) delay(20) }
    }

    @Test fun aTapOnTheHeaderSelectsTheBlockWithNoCallout() = textFirstSession(note) { c ->
        val view = c.view
        val (x, y) = header(view)
        tapNoteAt(view, x, y)
        withTimeout(5_000) { while (view.selectedCodeBlock == null) delay(20) }
        delay(300)
        assertTrue("a tap showed the callout", !view.codeTouch.callout.isShowing)
    }

    /** The one way it worked before, "kinda busted": the platform's text menu and two handles over the selected block. */
    @Test fun aHoldInsideTheSelectedBlockKeepsItWithItsCalloutAndNoHandles() = textFirstSession(note) { c ->
        val view = c.view
        header(view)
        // Selected without a header tap: the tap raises the keyboard, whose resize would move the note under the hold.
        val code = view.editableText.indexOf("a = 1")
        view.engine!!.selectCodeBlock(code)
        withTimeout(5_000) { while (view.selectedCodeBlock == null) delay(20) }
        val selected = view.selectedCodeBlock
        val layout = view.layout
        val line = layout.getLineForOffset(code)
        val codeX = view.totalPaddingLeft + layout.getPrimaryHorizontal(code)
        val codeY = view.totalPaddingTop - view.scrollY + (layout.getLineTop(line) + layout.getLineBottom(line)) / 2f
        // In real time: the TextView's long press fires from a delayed callback, not from the events' times.
        val down = android.os.SystemClock.uptimeMillis()
        val press = android.view.MotionEvent.obtain(down, down, android.view.MotionEvent.ACTION_DOWN, codeX, codeY, 0)
        press.source = android.view.InputDevice.SOURCE_TOUCHSCREEN
        view.dispatchTouchEvent(press)
        press.recycle()
        delay(android.view.ViewConfiguration.getLongPressTimeout() + 300L)
        val lift = android.view.MotionEvent.obtain(down, android.os.SystemClock.uptimeMillis(), android.view.MotionEvent.ACTION_UP, codeX, codeY, 0)
        lift.source = android.view.InputDevice.SOURCE_TOUCHSCREEN
        view.dispatchTouchEvent(lift)
        lift.recycle()
        awaitCallout(view)
        assertEquals(selected, view.selectedCodeBlock)
    }
}
