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

    private fun hold(view: TextFirstEditText, x: Float, y: Float) {
        val down = SystemClock.uptimeMillis()
        for ((action, time) in listOf(MotionEvent.ACTION_DOWN to down, MotionEvent.ACTION_UP to down + 700L)) {
            val event = MotionEvent.obtain(down, time, action, x, y, 0)
            event.source = InputDevice.SOURCE_TOUCHSCREEN
            try { view.dispatchTouchEvent(event) } finally { event.recycle() }
        }
    }

    private fun openField(view: TextFirstEditText): android.widget.EditText {
        val host = view.parent as android.view.ViewGroup
        return (0 until host.childCount).map(host::getChildAt).filterIsInstance<android.widget.EditText>().first { it !== view }
    }

    /**
     * Mason's report: the text bounced between the drawn header and the open field, and the field's
     * highlight hugged the top. The field's baseline is the drawn label's, opening, typing and closing.
     */
    @Test fun aHeaderFieldsTextSitsOnTheDrawnLabelsBaselineAndItsHighlightIsCentred() = textFirstSession("```js name:server.go\nconst a = 1\n```\n\nafter") { c ->
        val view = c.view
        view.isFocusableInTouchMode = true
        withTimeout(5_000) { while (view.codeChrome.areaOf(0, CodeBlockAction.NAME_FIELD) == null) delay(20) }
        val area = view.codeChrome.areaOf(0, CodeBlockAction.NAME_FIELD)!!
        val drawn = view.totalPaddingTop - view.scrollY + view.codeChrome.headerBaseline(area.top, view.style.mono)
        hold(view, view.totalPaddingLeft + area.centerX(), view.totalPaddingTop - view.scrollY + area.centerY())
        val field = openField(view)
        withTimeout(5_000) { while (field.layout == null || field.height <= 1) delay(20) }
        fun fieldBaseline() = field.top - view.top + field.baseline.toFloat()
        assertEquals(drawn, fieldBaseline(), 1f)
        val line = field.layout
        val highlightCentre = field.top - view.top + field.totalPaddingTop + (line.getLineTop(0) + line.getLineBottom(0)) / 2f
        // Centred on what the eye sees: from the capitals' top to the descenders' bottom.
        val capital = android.graphics.Rect().also { field.paint.getTextBounds("H", 0, 1, it) }
        val inkCentre = fieldBaseline() + (capital.top + field.paint.fontMetrics.descent) / 2f
        assertEquals(inkCentre, highlightCentre, 1f)
        val input = field.onCreateInputConnection(android.view.inputmethod.EditorInfo())!!
        for (letter in "abcde") {
            input.commitText(letter.toString(), 1)
            c.sourceText()
            delay(50)
            assertEquals("after typing $letter", drawn, fieldBaseline(), 1f)
        }
    }

    /**
     * Mason's report: a hold to change the language slid the note up and left the caret in the wrong
     * place. Opening a field never scrolls the note to the note's own caret, never moves a field that
     * is already visible, and brings a field the keyboard covers above it; the note draws no caret
     * while a field has the keyboard.
     */
    @Test fun openingAHeaderFieldKeepsTheNoteStillAndTheFieldInView() = textFirstSession("```js\nconst a = 1\n```\n" + "line\n".repeat(80) + "```py\nb = 2\n```\n" + "end\n".repeat(40)) { c ->
        val view = c.view
        view.isFocusableInTouchMode = true
        withTimeout(5_000) { while (view.codeChrome.areaOf(0, CodeBlockAction.LANGUAGE_LABEL) == null) delay(20) }
        // The note's caret far below, where a reveal of it would scroll the note.
        textFirstIme(c) { setSelection(view.length() - 10, view.length() - 10) }
        c.sourceText()
        view.scrollTo(0, 0)
        delay(300)
        val area = view.codeChrome.areaOf(0, CodeBlockAction.LANGUAGE_LABEL)!!
        hold(view, view.totalPaddingLeft + area.centerX(), view.totalPaddingTop + area.centerY())
        val field = openField(view)
        withTimeout(5_000) { while (field.height <= 1) delay(20) }
        val top = field.top
        // Whatever the keyboard does meanwhile (it may resize the window), give it time.
        delay(1_500)
        assertEquals("the note scrolled while a visible field opened", 0, view.scrollY)
        assertEquals("the open field moved", top, field.top)
        assertEquals("the note's caret is drawn while a field is open", false, view.isFocused)
    }

    /**
     * Mason's report: a hold on the language did nothing, or the wrong thing. A real hold lasts
     * through redraws (the caret blinks) and drifts a few pixels, here from the label onto the copy
     * glyph; it still opens the language field.
     */
    @Test fun aHoldOnTheLanguageSurvivesRedrawsAndDriftOntoTheGlyph() = textFirstSession(raw) { c ->
        val view = c.view
        view.isFocusableInTouchMode = true
        withTimeout(5_000) { while (view.codeChrome.areaOf(0, CodeBlockAction.LANGUAGE_LABEL) == null) delay(20) }
        val label = view.codeChrome.areaOf(0, CodeBlockAction.LANGUAGE_LABEL)!!
        val glyph = view.codeChrome.areaOf(0, CodeBlockAction.COPY_CODE)!!
        val y = view.totalPaddingTop + label.centerY()
        val down = SystemClock.uptimeMillis()
        fun send(action: Int, time: Long, x: Float) {
            val event = MotionEvent.obtain(down, time, action, x, y, 0)
            event.source = InputDevice.SOURCE_TOUCHSCREEN
            try { view.dispatchTouchEvent(event) } finally { event.recycle() }
        }
        send(MotionEvent.ACTION_DOWN, down, view.totalPaddingLeft + label.right - 2f)
        // Frames drawn during the hold rebuild the chrome's press targets.
        view.invalidate()
        delay(100)
        send(MotionEvent.ACTION_MOVE, down + 300L, view.totalPaddingLeft + glyph.left + 2f)
        view.invalidate()
        delay(100)
        send(MotionEvent.ACTION_UP, down + 700L, view.totalPaddingLeft + glyph.left + 3f)
        val field = openField(view)
        assertEquals("js", field.text.toString())
    }

    /** Mason's report: a field opened where the keyboard then covered it. It is brought into view, and only then. */
    @Test fun aFieldTheKeyboardCoversIsBroughtIntoView() = textFirstSession("line\n".repeat(30) + "```py\nb = 2\n```\n" + "end\n".repeat(60)) { c ->
        val view = c.view
        view.isFocusableInTouchMode = true
        val codeStart = view.editableText.indexOf("b = 2")
        withTimeout(5_000) { while (view.codeChrome.areaOf(codeStart, CodeBlockAction.LANGUAGE_LABEL) == null) delay(20) }
        val area = view.codeChrome.areaOf(codeStart, CodeBlockAction.LANGUAGE_LABEL)!!
        hold(view, view.totalPaddingLeft + area.centerX(), view.totalPaddingTop - view.scrollY + area.centerY())
        val field = openField(view)
        withTimeout(5_000) { while (field.height <= 1) delay(20) }
        val before = view.scrollY
        // The keyboard rises and the window shrinks to above the block's header.
        val params = view.layoutParams
        params.height = (view.totalPaddingTop - view.scrollY + area.top).toInt()
        view.layoutParams = params
        withTimeout(5_000) { while (view.height != params.height) delay(20) }
        withTimeout(5_000) { while (field.bottom > view.bottom) delay(20) }
        assert(view.scrollY > before) { "the note did not scroll" }
        assert(field.top >= view.top) { "the field went above the note" }
        // Typing writes the fence; the note stays where it is and the field on its block. The real
        // keyboard may rise meanwhile and bring the field above it once: measure after it settles.
        delay(1_500)
        val scrolled = view.scrollY
        val input = field.onCreateInputConnection(android.view.inputmethod.EditorInfo())!!
        for (letter in "rb") {
            input.commitText(letter.toString(), 1)
            c.sourceText()
            delay(300)
            assertEquals("the note scrolled after typing $letter", scrolled, view.scrollY)
        }
        val now = view.codeChrome.areaOf(codeStart, CodeBlockAction.LANGUAGE_LABEL)!!
        assertEquals("the field left its block", view.top + view.totalPaddingTop - view.scrollY + now.top, field.top.toFloat(), 1f)
    }
}
