package com.futo.notes.textfirst

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertTrue
import org.junit.Ignore
import org.junit.Test

/**
 * Mason (S23, a409ea1cb): "I can't click on empty cells". His note's last row has one cell and no closing pipe, so a tap
 * on its second or third column lands on a column the row lacks, and nothing opens. A truly empty cell in a full row
 * opens (checked on the emulator). Recorded in job10/tap-missing-column.mp4.
 */
class TextFirstTableMissingCellTest {
    private val note = "Table:\n\n| Left | Centre | Right |\n| :--- | :----: | ----: |\n| a | **b** | `c` |\n| a |  | c |\n| lon\n\nend"

    @Ignore("needs an engine call that enters a column the row lacks (asked of the Desktop Editor chat) and Mason's table design")
    @Test fun aTapOnAColumnTheRowLacksOpensThatCell() = textFirstSession(note) { c ->
        val view = c.view
        withContext(Dispatchers.Main) { view.isFocusableInTouchMode = true; view.requestFocus() }
        withTimeout(5_000) { while (view.layout == null) delay(20) }
        val (x, y) = withContext(Dispatchers.Main) {
            val e = view.editableText
            val row = e.getSpans(0, e.length, TfTableRow::class.java).single { e.substring(e.getSpanStart(it), e.getSpanEnd(it)).startsWith("| lon") }
            val l = view.layout
            val line = l.getLineForOffset(e.getSpanStart(row))
            (view.totalPaddingLeft + row.cellWidth * 1.5f) to (view.totalPaddingTop - view.scrollY + (l.getLineTop(line) + l.getLineBottom(line)) / 2f)
        }
        withContext(Dispatchers.Main) { tapNoteAt(view, x, y) }
        withTimeout(3_000) { while (c.cellView == null) delay(20) }
        assertTrue("the tapped cell's field is open", c.cellView != null)
    }
}
