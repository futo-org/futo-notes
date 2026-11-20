package com.futo.notes.textfirst

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** Mason (batch 3, 7): a selected line break shows a space's width of tint after its row's text, as on desktop. */
class SelectedPartOfRowTest {
    // "alpha\n" then "beta" wrapped as "beta gamma " + "delta\n", then the note's last line "end".
    private val alpha = TextRow(0, 6, 5, endsWithBreak = true)
    private val wrapped = TextRow(6, 17, 16, endsWithBreak = false)
    private val delta = TextRow(17, 23, 22, endsWithBreak = true)
    private val empty = TextRow(23, 24, 23, endsWithBreak = true)
    private val last = TextRow(24, 27, 27, endsWithBreak = false)

    @Test fun aBreakSelectedAtTheEndOfATextRowShowsAfterItsText() =
        assertEquals(RowSelection(2, 5, 5), selectedPartOfRow(alpha, 2, 10))

    @Test fun aBreakNotSelectedShowsNothingPastTheText() =
        assertEquals(RowSelection(2, 5, null), selectedPartOfRow(alpha, 2, 5))

    @Test fun aSoftWrapShowsNoBreak() =
        assertEquals(RowSelection(6, 16, null), selectedPartOfRow(wrapped, 2, 20))

    @Test fun aWrappedParagraphShowsItsBreakOnItsLastRowOnly() {
        assertEquals(RowSelection(6, 16, null), selectedPartOfRow(wrapped, 6, 24))
        assertEquals(RowSelection(17, 22, 22), selectedPartOfRow(delta, 6, 24))
    }

    @Test fun theFirstRowOfASelectionStartingAtTheEndOfItsTextShowsOnlyItsBreak() =
        assertEquals(RowSelection(5, 5, 5), selectedPartOfRow(alpha, 5, 10))

    @Test fun theRowASelectionEndsAtTheStartOfShowsNothing() =
        assertNull(selectedPartOfRow(delta, 2, 17))

    @Test fun emptyRowsAtEitherEndShowTheirBreakOnlyWhenItIsSelected() {
        assertEquals(RowSelection(23, 23, 23), selectedPartOfRow(empty, 23, 26))
        assertEquals(RowSelection(23, 23, 23), selectedPartOfRow(empty, 10, 24))
        assertNull(selectedPartOfRow(empty, 10, 23))
    }

    @Test fun theNotesLastLineShowsNoBreak() =
        assertEquals(RowSelection(24, 27, null), selectedPartOfRow(last, 2, 27))

    @Test fun aRightToLeftRowsBreakShowsLeftOfItsText() {
        assertEquals(90f to 100f, lineBreakTintEdges(100f, 10f, rightToLeft = true))
        assertEquals(100f to 110f, lineBreakTintEdges(100f, 10f, rightToLeft = false))
    }
}
