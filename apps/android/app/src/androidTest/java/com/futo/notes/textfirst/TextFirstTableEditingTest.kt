package com.futo.notes.textfirst

import android.view.KeyEvent
import org.junit.Assert.*
import org.junit.Test

/** The cell's typing, grip actions, column widths and short-row taps, through the keyboard's own calls and the note file. */
class TextFirstTableEditingTest {
    /** Typing "But you let me" word by word with the keyboard's own calls, spaces included. */
    @Test fun aCellKeepsTheSpacesTypedAtItsEdgeAndTheKeyboardReadsTheSameText() = textFirstSession(
        "| Item | Note |\n| --- | --- |\n| Bread |  |\n",
    ) { c ->
        val at = c.view.text.toString().indexOf("Bread")
        assertTrue(c.selectDisplayRange(at, at + 5))
        textFirstIme(c, cell = true) { sendKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_TAB)) }
        assertEquals("", c.cellView!!.text.toString())
        for (word in listOf("But", " ", "you", " ", "let", " ", "me")) {
            textFirstIme(c, cell = true) { commitText(word, 1) }
            val field = c.cellView!!
            val typed = field.text.toString()
            assertEquals("The field shows what the engine holds, edge spaces included", typed.length, field.selectionStart)
            if (word == " ") assertTrue("A typed space at the cell's edge is in the field", typed.endsWith(" "))
            textFirstIme(c, cell = true) {
                assertEquals("The keyboard reads the field's text before the caret", typed, getTextBeforeCursor(100, 0).toString())
                assertEquals("", getTextAfterCursor(100, 0).toString())
                assertEquals("The keyboard's caps mode follows the field's text", android.text.TextUtils.getCapsMode(typed, typed.length, android.text.TextUtils.CAP_MODE_SENTENCES), getCursorCapsMode(android.text.TextUtils.CAP_MODE_SENTENCES))
            }
        }
        assertEquals("| Item | Note |\n| --- | --- |\n| Bread | But you let me |\n", c.sourceText())
        // A typed trailing space is kept by the field while the cell is open.
        textFirstIme(c, cell = true) { commitText(" ", 1) }
        assertEquals("But you let me ", c.cellView!!.text.toString())
        assertEquals("But you let me ".length, c.cellView!!.selectionStart)
    }

    /** A Backspace shrinks the content; the row's own padding space must not become field text. */
    @Test fun aBackspaceDoesNotPullTheRowsPaddingIntoTheField() = textFirstSession(
        "| h |\n| --- |\n| abc |\n",
    ) { c ->
        val at = c.view.text.toString().indexOf("abc")
        assertTrue(c.selectDisplayRange(at + 3, at + 3))
        textFirstIme(c, cell = true) { deleteSurroundingText(1, 0) }
        assertEquals("ab", c.cellView!!.text.toString())
        assertTrue(c.selectDisplayRange(at + 2, at + 2))
        textFirstIme(c, cell = true) { commitText("X", 1) }
        assertEquals("| h |\n| --- |\n| abX |\n", c.sourceText())
    }

    /** Selecting the whole field, trailing space included, and composing over it: the window cannot index past the text. */
    @Test fun composingOverASelectedCellWithATrailingSpaceDoesNotCrash() = textFirstSession(
        "| h |\n| --- |\n| Word |\n",
    ) { c ->
        val at = c.view.text.toString().indexOf("Word")
        assertTrue(c.selectDisplayRange(at + 4, at + 4))
        textFirstIme(c, cell = true) { commitText(" ", 1) }
        textFirstIme(c, cell = true) { setSelection(0, 5) }
        textFirstIme(c, cell = true) { setComposingText("x", 1) }
        val field = c.cellView!!
        val text = field.text.toString()
        assertTrue("The field holds the composition: '$text' / source ${c.sourceText()?.replace("\n", "/")}", text.contains("x"))
        val composing = field.editableText.getSpans(0, text.length, android.text.style.UnderlineSpan::class.java)
        for (span in composing) assertTrue(field.editableText.getSpanEnd(span) <= text.length)
        textFirstIme(c, cell = true) { finishComposingText() }
    }

    @Test fun aRowActionAndItsUndoAreOneStepEachAndDeleteTableComesBackWithItsCell() = textFirstSession(
        "Top\n\n| h1 | h2 |\n| --- | --- |\n| d1 | d2 |\n\nEnd\n",
    ) { c ->
        val source = c.sourceText()!!
        val at = c.view.text.toString().indexOf("d1")
        assertTrue(c.selectDisplayRange(at, at))
        c.tableCommand(uniffi.futo_notes_ffi.EditorTableCommand.INSERT_ROW_BELOW)
        assertEquals(source.replace("| d1 | d2 |\n", "| d1 | d2 |\n|  |  |\n"), c.sourceText())
        c.undo()
        assertEquals("One Undo step, byte-identical", source, c.sourceText())
        assertEquals("d1", c.cellView!!.text.toString())
        c.deleteTable()
        assertEquals("Top\n\n\n\nEnd\n", c.sourceText())
        assertNull("The table's cell has closed with it", c.cellView)
        c.undo()
        assertEquals("One Undo step, byte-identical", source, c.sourceText())
        assertEquals("Undo brings the table back with its cell open", "d1", c.cellView?.text.toString())
    }

    @Test fun aTypedPipeWidensEveryRowOfTheTableAndItsUndoNarrowsThem() = textFirstSession(
        "| h1 | h2 |\n| --- | --- |\n| d1 | d2 |\n| d3 | d4 |\n",
    ) { c ->
        fun widths() = c.view.editableText.getSpans(0, c.view.editableText.length, TfTableRow::class.java).map { it.columns }
        val source = c.sourceText()
        val at = c.view.text.toString().indexOf("d1")
        assertTrue(c.selectDisplayRange(at + 2, at + 2))
        assertEquals(listOf(2, 2, 2), widths())
        textFirstIme(c, cell = true) { commitText("|", 1) }
        assertEquals("Every row is drawn at the table's new width", listOf(3, 3, 3), widths())
        c.undo()
        assertEquals(source, c.sourceText())
        textFirstIme(c) { }
        assertEquals(listOf(2, 2, 2), widths())
    }

    @Test fun anEmptyBoxOfAShortRowIsEnteredThroughItsOwnTableNotTheOneAbove() = textFirstSession(
        "| A | B | C |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n\ntext\n\n| P | Q | R |\n| --- | --- | --- |\n| p |\n",
    ) { c ->
        val source = c.sourceText()!!
        val view = c.view
        val row = view.text.toString().indexOf("p")
        val span = view.editableText.getSpans(row, row, TfTableRow::class.java).single()
        view.tableTouch.hooks.missing!!(view.editableText.getSpanStart(span), 2, view.appliedSeq)
        assertEquals(source.replace("| p |\n", "| p |  |  |\n"), c.sourceText())
        assertEquals("The field opens on the box that was tapped", "", c.cellView!!.text.toString())
        assertEquals(2, c.cellView!!.placementTarget(view)!!.column)
        c.undo()
        assertEquals("One Undo step, byte-identical", source, c.sourceText())
    }
}
