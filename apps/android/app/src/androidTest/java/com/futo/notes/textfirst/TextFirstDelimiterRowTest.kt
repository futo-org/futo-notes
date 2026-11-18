package com.futo.notes.textfirst

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
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

    private suspend fun keyboardMove(c: TextFirstController, from: Int, to: Int) {
        c.select(from)
        awaitCaret(c, from)
        textFirstIme(c) { setSelection(to, to) }
        c.sourceText()
    }

    /** A keyboard's cursor moves arrive as absolute setSelection calls, one character at a time, and are placed. */
    @Test fun aKeyboardMoveDownOntoTheRowGoesPastIt() = textFirstSession(note) { c ->
        val (headerEnd, row, nextStart) = rowEdges(c)
        keyboardMove(c, headerEnd, row + 1)
        awaitCaret(c, nextStart)
    }

    /** The verifier's trap: one step left from the first body row landed on the row's end and went back. */
    @Test fun aKeyboardMoveUpOntoTheRowGoesPastIt() = textFirstSession(note) { c ->
        val (headerEnd, _, nextStart) = rowEdges(c)
        keyboardMove(c, nextStart, nextStart - 1)
        awaitCaret(c, headerEnd)
    }

    @Test fun aCaretPlacedOnTheRowFromBelowGoesAbove() = textFirstSession(note) { c ->
        val (headerEnd, row, _) = rowEdges(c)
        c.select(c.view.editableText.indexOf("b"))
        awaitCaret(c, c.view.editableText.indexOf("b"))
        withContext(Dispatchers.Main) { c.view.setSelection(row + 2) }
        c.sourceText()
        awaitCaret(c, headerEnd)
        assertEquals(headerEnd to headerEnd, c.view.selectionStart to c.view.selectionEnd)
    }
}
