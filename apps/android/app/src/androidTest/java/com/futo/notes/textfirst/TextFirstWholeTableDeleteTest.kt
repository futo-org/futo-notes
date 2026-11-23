package com.futo.notes.textfirst

import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Engine 46d72c694 (job 11 E): removing a selection that covers every cell of a table removes the table's lines whole.
 * FUTO Keyboard's Backspace over a selection (a collapse to its end, then a delete of its length) reaches the engine as
 * that removal: one empty line is left with the caret on it, and no row of the grid is left drawn.
 */
class TextFirstWholeTableDeleteTest {
    private suspend fun futoBackspace(c: TextFirstController, start: Int, end: Int) {
        textFirstIme(c) {
            setSelection(end, end)
            getTextBeforeCursor(1040, 0)
            finishComposingText()
            deleteSurroundingText(end - start, 0)
        }
    }

    /** [select] makes the selection and returns it once the view shows it. */
    private suspend fun removeWhole(c: TextFirstController, select: suspend (TextFirstEditText) -> Pair<Int, Int>, expected: String) {
        val view = c.view
        view.isFocusableInTouchMode = true
        view.requestFocus()
        withTimeout(5_000) { while (view.layout == null) delay(20) }
        val before = c.sourceText()
        val (start, end) = select(view)
        futoBackspace(c, start, end)
        withTimeout(5_000) { while (c.sourceText() == before) delay(20) }
        assertEquals(expected, c.sourceText())
        delay(300)
        val e = view.editableText
        assertTrue("a row of the grid is still drawn", e.getSpans(0, e.length, TfTableRow::class.java).isEmpty())
        assertEquals("the caret is not on the empty line", view.selectionStart, view.selectionEnd)
        val caret = view.selectionStart
        // The view's text ends in a zero-width sentinel, not a character of the note.
        val text = e.toString().trimEnd('\u200b')
        val emptyLine = (caret == 0 || text[caret - 1] == '\n') && (caret >= text.length || text[caret] == '\n')
        assertTrue("the caret at $caret is not on an empty line of \"$text\"", emptyLine)
    }

    @Test fun backspaceOverEveryCellRemovesTheTable() = textFirstSession("before\n\n| a | b |\n| - | - |\n| c | d |\n\nafter") { c ->
        removeWhole(c, { view ->
            val e = view.editableText
            val rows = e.getSpans(0, e.length, TfTableRow::class.java).sortedBy { e.getSpanStart(it) }
            val (start, end) = e.getSpanStart(rows.first()) to e.getSpanEnd(rows.last())
            c.select(start, end)
            withTimeout(5_000) { while (view.selectionStart != start || view.selectionEnd != end) delay(20) }
            start to end
        }, "before\n\n\n\nafter")
    }

    @Test fun backspaceAfterSelectAllInANoteThatIsOnlyATableRemovesIt() = textFirstSession("| a | b |\n| - | - |\n| c | d |") { c ->
        removeWhole(c, { view ->
            view.onTextContextMenuItem(android.R.id.selectAll)
            withTimeout(5_000) { while (view.selectionStart != 0 || view.selectionEnd == 0) delay(20) }
            delay(200)
            view.selectionStart to view.selectionEnd
        }, "")
    }
}
