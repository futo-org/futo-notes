package com.futo.notes.textfirst

import android.os.SystemClock
import android.view.InputDevice
import android.view.MotionEvent
import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Test

/** A code block's header fields: holds and taps open them, they sit on the drawn header, and the note stays still around them. */
class TextFirstCodeHeaderFieldTest {
    private val raw = "```js\nconst a = 1\nconst b = 2\n```\n\nafter"

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
        holdNoteAt(view, view.totalPaddingLeft + area.centerX(), view.totalPaddingTop - view.scrollY + area.centerY())
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
        holdNoteAt(view, view.totalPaddingLeft + area.centerX(), view.totalPaddingTop + area.centerY())
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
        holdNoteAt(view, view.totalPaddingLeft + area.centerX(), view.totalPaddingTop - view.scrollY + area.centerY())
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

    /** Verifier run 1, item 3: typing in the name field of the note's first block scrolled the note 52 px. */
    @Test fun typingInTheTopBlocksNameFieldLeavesTheNoteWhereItIs() = textFirstSession("```js name:server.go\nconst a = 1\n```\n" + "line\n".repeat(80)) { c ->
        val view = c.view
        view.isFocusableInTouchMode = true
        withTimeout(5_000) { while (view.codeChrome.areaOf(0, CodeBlockAction.NAME_FIELD) == null) delay(20) }
        val area = view.codeChrome.areaOf(0, CodeBlockAction.NAME_FIELD)!!
        holdNoteAt(view, view.totalPaddingLeft + area.centerX(), view.totalPaddingTop + area.centerY())
        val field = openField(view)
        withTimeout(5_000) { while (field.height <= 1) delay(20) }
        delay(1_500)
        val scrolled = view.scrollY
        val input = field.onCreateInputConnection(android.view.inputmethod.EditorInfo())!!
        input.commitText("x", 1)
        c.sourceText()
        delay(300)
        assertEquals("typing moved the note", scrolled, view.scrollY)
        input.sendKeyEvent(android.view.KeyEvent(android.view.KeyEvent.ACTION_DOWN, android.view.KeyEvent.KEYCODE_ENTER))
        c.sourceText()
        delay(300)
        assertEquals("leaving the field moved the note", scrolled, view.scrollY)
    }

    /** Verifier run 1, items 9 and 15: the editor keeps its toolbar while a header field is open, so the note never resizes on leave. */
    @Test fun theEditorStaysFocusedWhileAHeaderFieldIsOpen() = textFirstSession("```js name:server.go\nconst a = 1\n```\n\nafter") { c ->
        val view = c.view
        view.isFocusableInTouchMode = true
        withTimeout(5_000) { while (view.codeChrome.areaOf(0, CodeBlockAction.NAME_FIELD) == null) delay(20) }
        val area = view.codeChrome.areaOf(0, CodeBlockAction.NAME_FIELD)!!
        holdNoteAt(view, view.totalPaddingLeft + area.centerX(), view.totalPaddingTop + area.centerY())
        val field = openField(view)
        withTimeout(5_000) { while (!field.isFocused) delay(20) }
        assertEquals("the toolbar hides while the field is open", true, c.focused)
        field.onCreateInputConnection(android.view.inputmethod.EditorInfo())!!
            .sendKeyEvent(android.view.KeyEvent(android.view.KeyEvent.ACTION_DOWN, android.view.KeyEvent.KEYCODE_ENTER))
        assertEquals(true, c.focused)
    }

    /** Verifier run 1, items 7 and 20: a tap into an active block's name puts the caret at the tap at once, and the field keeps the header's grey ink. */
    @Test fun aTapIntoTheNameFieldPutsTheCaretThereAtOnceInTheHeadersInk() = textFirstSession("```js name:server.go\nconst a = 1\n```\n\nafter") { c ->
        val view = c.view
        view.isFocusableInTouchMode = true
        view.requestFocus()
        view.setSelection(view.editableText.indexOf("a = 1"))
        withTimeout(5_000) { while (view.codeChrome.areaOf(0, CodeBlockAction.NAME_FIELD) == null) delay(20) }
        delay(300)
        val area = view.codeChrome.areaOf(0, CodeBlockAction.NAME_FIELD)!!
        val nameEnd = area.left + view.style.codeCorner + android.text.TextPaint().apply { typeface = view.style.mono; textSize = view.style.codeHeaderTextSize }.measureText("server.go")
        tapNoteAt(view, view.totalPaddingLeft + nameEnd - 2f, view.totalPaddingTop + area.centerY())
        val field = openField(view)
        assertEquals("the caret starts away from the tap", "server.go".length, field.selectionStart)
        assertEquals(view.style.codeChromeInk, field.currentTextColor)
    }
}
