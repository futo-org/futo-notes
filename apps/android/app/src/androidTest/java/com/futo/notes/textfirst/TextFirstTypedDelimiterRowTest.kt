package com.futo.notes.textfirst

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * tables.md: while the person types a delimiter row (writes_delimiter_row) the host draws it as text, and hides it once
 * the finishing keystroke takes the caret to the first body row. Typed as FUTO Keyboard sends it: one commit per key, a
 * Backspace in the empty first cell as the DEL key (traced).
 */
class TextFirstTypedDelimiterRowTest {
    private fun TextFirstEditText.lineOf(text: String): Int = editableText.indexOf(text).also { check(it >= 0) { "No line $text" } }

    private suspend fun shownAsText(c: TextFirstController, row: Int): Boolean = withContext(Dispatchers.Main) {
        val e = c.view.editableText
        e.getSpans(row, row + 1, TfTableDelimiter::class.java).isEmpty() && e.getSpans(row, row + 1, TfTypedDelimiter::class.java).isNotEmpty() &&
            c.view.layout.let { it.getLineBottom(it.getLineForOffset(row)) - it.getLineTop(it.getLineForOffset(row)) > 0 }
    }

    private suspend fun hidden(c: TextFirstController, row: Int): Boolean = withContext(Dispatchers.Main) {
        val e = c.view.editableText
        e.getSpans(row, row + 1, TfTypedDelimiter::class.java).isEmpty() && e.getSpans(row, row + 1, TfTableDelimiter::class.java).isNotEmpty()
    }

    @Test fun aTypedDelimiterRowShowsAsTextUntilItIsFinishedAndAgainAfterBackspace() = textFirstSession("intro\n\n") { c ->
        val view = c.view
        withContext(Dispatchers.Main) { view.isFocusableInTouchMode = true; view.requestFocus() }
        withTimeout(5_000) { while (view.layout == null) delay(20) }
        c.select(view.editableText.length - 1)
        c.sourceText()
        for (key in "| a | b |") textFirstIme(c) { commitText(key.toString(), 1) }
        textFirstIme(c) { commitText("\n", 1) }
        for (key in "|---|---") textFirstIme(c) { commitText(key.toString(), 1) }
        c.sourceText()
        val row = view.lineOf("|---|---")
        withTimeout(5_000) { while (!shownAsText(c, row)) delay(20) }
        assertTrue("the caret is on the row being typed", view.selectionStart in row..row + "|---|---".length)
        textFirstIme(c) { commitText("|", 1) }
        assertEquals("intro\n\n| a | b |\n|---|---|\n|  |  |", c.sourceText()!!.trimEnd('\n'))
        withTimeout(5_000) { while (!hidden(c, row)) delay(20) }
        withTimeout(5_000) { while (c.cellView == null) delay(20) }
        // FUTO sees an empty cell before the caret and sends Backspace as the key.
        textFirstIme(c, cell = true) {
            sendKeyEvent(android.view.KeyEvent(android.view.KeyEvent.ACTION_DOWN, android.view.KeyEvent.KEYCODE_DEL))
            sendKeyEvent(android.view.KeyEvent(android.view.KeyEvent.ACTION_UP, android.view.KeyEvent.KEYCODE_DEL))
        }
        assertEquals("intro\n\n| a | b |\n|---|---", c.sourceText()!!.trimEnd('\n'))
        withTimeout(5_000) { while (!shownAsText(c, row) || c.cellView != null) delay(20) }
        withTimeout(5_000) { while (!view.hasFocus()) delay(20) }
        assertEquals("the caret is back at the row's end", row + "|---|---".length, view.selectionStart)
        textFirstIme(c) { commitText("|", 1) }
        withTimeout(5_000) { while (c.cellView == null) delay(20) }
        textFirstIme(c, cell = true) { commitText("x", 1) }
        assertEquals("intro\n\n| a | b |\n|---|---|\n| x |  |", c.sourceText()!!.trimEnd('\n'))
    }

    /** Verifier: Enter finishes the row too; FUTO's Backspace in the opened cell, then its read of the text, crashed. */
    @Test fun backspaceAfterEnterFinishedTheRowDoesNotCrash() = textFirstSession("intro\n\n") { c ->
        val view = c.view
        withContext(Dispatchers.Main) { view.isFocusableInTouchMode = true; view.requestFocus() }
        withTimeout(5_000) { while (view.layout == null) delay(20) }
        c.select(view.editableText.length - 1)
        c.sourceText()
        for (key in "| a | b |") textFirstIme(c) { commitText(key.toString(), 1) }
        textFirstIme(c) { commitText("\n", 1) }
        for (key in "|---|---") textFirstIme(c) { commitText(key.toString(), 1) }
        textFirstIme(c) { commitText("\n", 1) }
        withTimeout(5_000) { while (c.cellView == null) delay(20) }
        val cell = withContext(Dispatchers.Main) { c.cellView!!.onCreateInputConnection(android.view.inputmethod.EditorInfo())!! }
        textFirstIme(c, connection = cell) {
            sendKeyEvent(android.view.KeyEvent(android.view.KeyEvent.ACTION_DOWN, android.view.KeyEvent.KEYCODE_DEL))
            sendKeyEvent(android.view.KeyEvent(android.view.KeyEvent.ACTION_UP, android.view.KeyEvent.KEYCODE_DEL))
        }
        textFirstIme(c, connection = cell) { getTextBeforeCursor(1040, 0); getTextAfterCursor(1040, 0) }
        assertTrue("the note is still open", c.sourceText()!!.startsWith("intro"))
    }
}

