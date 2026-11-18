package com.futo.notes.textfirst

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Ignore
import org.junit.Test

/** A table's delimiter row holds no caret the user places or moves (tables.md): the engine puts it at the row's nearer edge. */
class TextFirstDelimiterRowTest {
    private val note = "a\n\n| x | y |\n| - | - |\n| 1 | 2 |\n\nb"

    private suspend fun rowEdges(c: TextFirstController): Triple<Int, Int, Int> {
        val view = c.view
        view.isFocusableInTouchMode = true
        withContext(Dispatchers.Main) { view.requestFocus() }
        withTimeout(5_000) { while (view.layout == null) delay(20) }
        val row = view.editableText.indexOf("| - | - |")
        val end = row + "| - | - |".length
        return Triple(row - 1, row, end + 1)
    }

    private suspend fun awaitCaret(c: TextFirstController, at: Int) {
        withTimeout(5_000) { while (c.view.selectionStart != at || c.view.selectionEnd != at) delay(20) }
    }

    /**
     * A keyboard's cursor moves arrive as absolute setSelection calls, one character at a time. Placed, a step left from
     * the first body row lands on the row's end and goes back to the nearer edge, so the caret could not leave the table
     * upward (verifier, 2026-11-18): place_selection needs the move's direction for this.
     */
    @Ignore("engine: place_selection has no direction; a keyboard's one-step move left off the body row is put back")
    @Test fun aKeyboardCursorMoveOntoTheRowLandsAtItsNearerEdge() = textFirstSession(note) { c ->
        val (headerEnd, row, _) = rowEdges(c)
        textFirstIme(c) { setSelection(row + 1, row + 1) }
        c.sourceText()
        awaitCaret(c, headerEnd)
        assertEquals(headerEnd to headerEnd, c.view.selectionStart to c.view.selectionEnd)
    }

    @Test fun aCaretPlacedOnTheRowLandsAtItsNearerEdge() = textFirstSession(note) { c ->
        val (_, row, nextStart) = rowEdges(c)
        withContext(Dispatchers.Main) { c.view.setSelection(row + "| - | -".length) }
        c.sourceText()
        awaitCaret(c, nextStart)
        assertEquals(nextStart to nextStart, c.view.selectionStart to c.view.selectionEnd)
    }
}
