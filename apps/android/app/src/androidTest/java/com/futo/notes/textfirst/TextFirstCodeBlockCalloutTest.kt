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

    /** In real time: the TextView's long press fires from a delayed callback, not from the events' times. */
    /** With the note focused: unfocused, a real hold lifts the block instead (BlockLift). */
    private suspend fun holdInRealTime(view: TextFirstEditText, x: Float, y: Float) {
        view.isFocusableInTouchMode = true
        view.requestFocus()
        val down = android.os.SystemClock.uptimeMillis()
        for (action in listOf(android.view.MotionEvent.ACTION_DOWN, android.view.MotionEvent.ACTION_UP)) {
            if (action == android.view.MotionEvent.ACTION_UP) delay(android.view.ViewConfiguration.getLongPressTimeout() + 300L)
            val event = android.view.MotionEvent.obtain(down, android.os.SystemClock.uptimeMillis(), action, x, y, 0)
            event.source = android.view.InputDevice.SOURCE_TOUCHSCREEN
            try { view.dispatchTouchEvent(event) } finally { event.recycle() }
        }
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

    /**
     * The one way it worked before, "kinda busted": the platform's text menu and two handles over the selected block.
     * Verifier (job 11): with the keyboard up, the lift after the hold put the caret under the finger.
     */
    @Test fun aHoldInsideTheSelectedBlockKeepsItWithItsCalloutAndNoHandles() = textFirstSession(note) { c ->
        val view = c.view
        val (x, y) = header(view)
        tapNoteAt(view, x, y)
        withTimeout(5_000) { while (view.selectedCodeBlock == null) delay(20) }
        val selected = view.selectedCodeBlock
        val code = view.editableText.indexOf("a = 1")
        val layout = view.layout
        val line = layout.getLineForOffset(code)
        val codeX = view.totalPaddingLeft + layout.getPrimaryHorizontal(code)
        val codeY = view.totalPaddingTop - view.scrollY + (layout.getLineTop(line) + layout.getLineBottom(line)) / 2f
        holdInRealTime(view, codeX, codeY)
        awaitCallout(view)
        assertEquals(selected, view.selectedCodeBlock)
    }

    /** Verifier (job 12): a hold on prose under a selected block put the TextView's handles on the block instead of selecting the word there. */
    @Test fun aHoldOnProseUnderASelectedBlockLeavesTheBlockForTheWordThere() = textFirstSession(note) { c ->
        val view = c.view
        val (x, y) = header(view)
        tapNoteAt(view, x, y)
        withTimeout(5_000) { while (view.selectedCodeBlock == null) delay(20) }
        val word = view.editableText.indexOf("after")
        val layout = view.layout
        val line = layout.getLineForOffset(word)
        val block = view.selectedCodeBlock!!
        holdInRealTime(view, view.totalPaddingLeft + layout.getPrimaryHorizontal(word + 2), view.totalPaddingTop - view.scrollY + (layout.getLineTop(line) + layout.getLineBottom(line)) / 2f)
        // The platform's word selection from there does not run in this activity (it does on the emulator, job12/):
        // what the block owns is that the hold leaves it, from the place the finger held.
        withTimeout(5_000) { while (view.selectedCodeBlock != null) delay(20) }
        assertTrue("the hold left the block's range selected", view.selectionStart to view.selectionEnd != block)
        assertTrue("the hold left its caret or selection away from the word, at ${view.selectionStart}", view.selectionStart in word..word + "after".length)
    }

    /** Sol review (job 14, 1): with block A's menu up, a header tap selecting block B closes it; Cut would have taken B. */
    @Test fun selectingAnotherBlockClosesTheMenu() = textFirstSession("intro\n\n```js\nconst a = 1\n```\n\nmiddle\n\n```py\nb = 2\n```\n\nafter") { c ->
        val view = c.view
        val (x, y) = header(view)
        holdNoteAt(view, x, y)
        awaitCallout(view)
        val second = view.editableText.indexOf("b = 2")
        withTimeout(5_000) { while (view.codeChrome.areaOf(second, CodeBlockAction.SELECT_BLOCK) == null) { view.invalidate(); delay(20) } }
        val area = view.codeChrome.areaOf(second, CodeBlockAction.SELECT_BLOCK)!!
        tapNoteAt(view, view.totalPaddingLeft + area.left + area.width() * 0.6f, view.totalPaddingTop - view.scrollY + area.centerY())
        withTimeout(5_000) { while (view.selectedCodeBlock?.first != second) delay(20) }
        delay(300)
        assertTrue("block A's menu still shows over block B's selection", !view.codeTouch.callout.isShowing)
    }

    /** Sol review (11): a second finger on the header makes the press a gesture: lifting after the hold opens no menu. */
    @Test fun aSecondFingerOnTheHeaderOpensNoMenu() = textFirstSession(note) { c ->
        val view = c.view
        val (x, y) = header(view)
        val down = android.os.SystemClock.uptimeMillis()
        fun send(action: Int, at: Long, pointers: Int) {
            val ids = IntArray(pointers) { it }
            val coords = Array(pointers) { i -> android.view.MotionEvent.PointerCoords().apply { this.x = x + i * 80f; this.y = y } }
            val props = Array(pointers) { i -> android.view.MotionEvent.PointerProperties().apply { id = ids[i]; toolType = android.view.MotionEvent.TOOL_TYPE_FINGER } }
            val event = android.view.MotionEvent.obtain(down, at, action, pointers, props, coords, 0, 0, 1f, 1f, 0, 0, android.view.InputDevice.SOURCE_TOUCHSCREEN, 0)
            try { view.dispatchTouchEvent(event) } finally { event.recycle() }
        }
        send(android.view.MotionEvent.ACTION_DOWN, down, 1)
        send(android.view.MotionEvent.ACTION_POINTER_DOWN or (1 shl android.view.MotionEvent.ACTION_POINTER_INDEX_SHIFT), down + 50, 2)
        send(android.view.MotionEvent.ACTION_POINTER_UP or (1 shl android.view.MotionEvent.ACTION_POINTER_INDEX_SHIFT), down + 100, 2)
        send(android.view.MotionEvent.ACTION_UP, down + 900, 1)
        delay(800)
        assertTrue("a two-finger press opened the block menu", !view.codeTouch.callout.isShowing)
    }

    /** Sol review (3): a hold on a long block's header while the note still loads keeps the block selected with its menu. */
    @Test fun aHoldWhileTheNoteLoadsKeepsTheBlockAndItsMenu() = textFirstSession("```js\n" + (1..1200).joinToString("\n") { "const value$it = $it" } + "\n```\n\nafter") { c ->
        val view = c.view
        withTimeout(5_000) { while (view.codeChrome.areaOf(0, CodeBlockAction.SELECT_BLOCK) == null) { view.invalidate(); delay(5) } }
        val area = view.codeChrome.areaOf(0, CodeBlockAction.SELECT_BLOCK)!!
        holdNoteAt(view, view.totalPaddingLeft + area.left + area.width() * 0.6f, view.totalPaddingTop - view.scrollY + area.centerY())
        withTimeout(10_000) { while (view.text?.contains("after") != true) delay(20) }
        delay(500)
        assertTrue("the block is no longer selected", view.selectedCodeBlock != null)
        assertTrue("the menu closed", view.codeTouch.callout.isShowing)
    }
}
