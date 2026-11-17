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
        val field = openHeaderField(view)
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
        val field = openHeaderField(view)
        assertEquals("js", field.text.toString())
    }

    /**
     * Verifier runs 2 and 3: while its header field is open the block stays the one being edited, as on !300:
     * its "name" ghost and "add a line above" stay, and the editor toolbar keeps the state it had.
     */
    @Test fun aBlockStaysActiveWhileItsHeaderFieldIsOpen() = textFirstSession("```js\nconst a = 1\n```\n\nafter") { c ->
        val view = c.view
        view.codeChrome.labels = CodeBlockLabels("add a line above", "add a line below", "name", "language")
        view.isFocusableInTouchMode = true
        view.requestFocus()
        val codeStart = view.editableText.indexOf("const a")
        withTimeout(5_000) { while (view.codeChrome.areaOf(codeStart, CodeBlockAction.LANGUAGE_LABEL) == null) delay(20) }
        val area = view.codeChrome.areaOf(codeStart, CodeBlockAction.LANGUAGE_LABEL)!!
        holdNoteAt(view, view.totalPaddingLeft + area.centerX(), view.totalPaddingTop + area.centerY())
        val field = openHeaderField(view)
        withTimeout(5_000) { while (!field.isFocused) delay(20) }
        delay(300)
        assert(view.codeChrome.areaOf(codeStart, CodeBlockAction.OPEN_LINE_ABOVE) != null) { "\"add a line above\" went while the field is open" }
        assertEquals("the editor toolbar went when the field opened", true, c.focused)
        field.onCreateInputConnection(android.view.inputmethod.EditorInfo())!!
            .sendKeyEvent(android.view.KeyEvent(android.view.KeyEvent.ACTION_DOWN, android.view.KeyEvent.KEYCODE_ENTER))
        assertEquals(true, c.focused)
    }

    /** Verifier run 1, item 7, and run 2: a tap into an active block's name puts the caret at the tap at once, and the field is inked as text. */
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
        val field = openHeaderField(view)
        assertEquals("the caret starts away from the tap", "server.go".length, field.selectionStart)
        assertEquals(view.style.textColor, field.currentTextColor)
    }

    /** Verifier run 1, item 13: with the caret in the block, a tap on the language label opens its field with the word selected. */
    @Test fun aTapOnTheLanguageWithTheCaretInsideSelectsTheWord() = textFirstSession(raw) { c ->
        val view = c.view
        view.isFocusableInTouchMode = true
        view.requestFocus()
        view.setSelection(view.editableText.indexOf("a = 1"))
        withTimeout(5_000) { while (view.codeChrome.areaOf(0, CodeBlockAction.LANGUAGE_LABEL) == null) delay(20) }
        delay(300)
        val area = view.codeChrome.areaOf(0, CodeBlockAction.LANGUAGE_LABEL)!!
        tapNoteAt(view, view.totalPaddingLeft + area.centerX(), view.totalPaddingTop + area.centerY())
        val field = openHeaderField(view)
        assertEquals(0 to "js".length, field.selectionStart to field.selectionEnd)
    }

    /** Verifier run 5: a field is its text and a constant collar, with no minimum, as !300's spec says ("no pocket of space"). */
    @Test fun aOneLetterLanguageFieldIsItsTextAndTheCollar() = textFirstSession("```x\nconst a = 1\n```\n\nafter") { c ->
        val view = c.view
        view.isFocusableInTouchMode = true
        withTimeout(5_000) { while (view.codeChrome.areaOf(0, CodeBlockAction.LANGUAGE_LABEL) == null) delay(20) }
        val area = view.codeChrome.areaOf(0, CodeBlockAction.LANGUAGE_LABEL)!!
        holdNoteAt(view, view.totalPaddingLeft + area.centerX(), view.totalPaddingTop + area.centerY())
        val field = openHeaderField(view)
        withTimeout(5_000) { while (field.width <= 1) delay(20) }
        val look = view.style
        assertEquals(field.paint.measureText("x") + look.codeChipPad * 2 + look.dp(1f), field.width.toFloat(), 1f)
    }
}
