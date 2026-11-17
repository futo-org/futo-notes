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
        tap(view, view.width / 2f, view.totalPaddingTop + view.layout.getLineTop(0) + view.style.codeHeaderHeight / 2f)
    }

    private fun tap(view: TextFirstEditText, x: Float, y: Float) {
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

    @Test fun aTapUnderABlockThatEndsTheNoteOpensALineAndRaisesTheKeyboard() = textFirstSession("```js\nconst a = 1\n```") { c ->
        val view = c.view
        view.isFocusableInTouchMode = true
        view.hideKeyboard()
        withTimeout(5_000) { while (view.layout == null || view.editableText.getSpans(0, 1, TfCodeBlock::class.java).isEmpty()) delay(20) }
        val below = view.totalPaddingTop + view.layout.height + view.style.dp(40f)
        withTimeout(5_000) { while (view.codeChrome.targetAt(view.width / 2f, below - view.totalPaddingTop) == null) delay(20) }
        tap(view, view.width / 2f, below)
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
        tap(view, view.width / 2f, view.totalPaddingTop - 2f)
        c.sourceText()
        assertEquals(focused, view.isFocused)
        assertEquals(selection, view.selectionStart to view.selectionEnd)
    }

    @Test fun aTapInsideAnEmptySelectedBlockLetsTheNextLetterTypeIntoIt() = textFirstSession("intro\n\n```js\n\n```\n\nafter") { c ->
        val view = c.view
        val code = view.editableText.indexOf("\n\n") + 2
        withTimeout(5_000) { while (view.layout == null || view.editableText.getSpans(code, code + 1, TfCodeBlock::class.java).isEmpty()) delay(20) }
        val line = view.layout.getLineForOffset(code)
        tap(view, view.width / 2f, view.totalPaddingTop + view.layout.getLineTop(line) + view.style.codeHeaderHeight / 2f)
        awaitSelectedBlock(view)
        // Past the double-tap window, so this reads as a second, separate tap.
        delay(500)
        tap(view, view.width / 2f, view.totalPaddingTop + view.layout.getLineBaseline(line).toFloat())
        withTimeout(5_000) { while (view.selectedCodeBlock != null) delay(20) }
        textFirstIme(c) { commitText("x", 1) }
        assertEquals("intro\n\n```js\nx\n```\n\nafter", c.sourceText())
    }

    /** A hold on the language opens its field with the text selected; typing writes the fence, Enter goes to the code. */
    @Test fun aHoldOnTheLanguageEditsItAndEnterReturnsToTheCode() = textFirstSession(raw) { c ->
        val view = c.view
        view.isFocusableInTouchMode = true
        withTimeout(5_000) { while (view.layout == null || view.editableText.getSpans(0, 1, TfCodeBlock::class.java).isEmpty()) delay(20) }
        withTimeout(5_000) { while (view.codeChrome.areaOf(0, CodeBlockAction.LANGUAGE_LABEL) == null) delay(20) }
        val area = view.codeChrome.areaOf(0, CodeBlockAction.LANGUAGE_LABEL)!!
        val x = view.totalPaddingLeft + area.centerX()
        val y = view.totalPaddingTop + area.centerY()
        val down = SystemClock.uptimeMillis()
        for ((action, time) in listOf(MotionEvent.ACTION_DOWN to down, MotionEvent.ACTION_UP to down + 700L)) {
            val event = MotionEvent.obtain(down, time, action, x, y, 0)
            event.source = InputDevice.SOURCE_TOUCHSCREEN
            try { view.dispatchTouchEvent(event) } finally { event.recycle() }
        }
        val host = view.parent as android.view.ViewGroup
        val field = (0 until host.childCount).map(host::getChildAt).filterIsInstance<android.widget.EditText>().first { it !== view }
        assertEquals("js", field.text.toString().substring(field.selectionStart, field.selectionEnd))
        val input = field.onCreateInputConnection(android.view.inputmethod.EditorInfo())!!
        input.commitText("kotlin", 1)
        assertEquals("```kotlin\nconst a = 1\nconst b = 2\n```\n\nafter", c.sourceText())
        input.sendKeyEvent(android.view.KeyEvent(android.view.KeyEvent.ACTION_DOWN, android.view.KeyEvent.KEYCODE_ENTER))
        c.sourceText()
        assertEquals(0 to 0, view.selectionStart to view.selectionEnd)
        assertEquals(false, field.isAttachedToWindow)
    }
}
