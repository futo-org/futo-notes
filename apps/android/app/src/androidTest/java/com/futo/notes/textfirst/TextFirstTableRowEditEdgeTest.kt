package com.futo.notes.textfirst

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Sol (round 4): an edit whose edge falls inside a table row, in a note long enough that its restyle is paced from
 * elsewhere, must not leave the row drawn from cells that are no longer under it, not even until styling catches up.
 */
class TextFirstTableRowEditEdgeTest {
    private val note = (1..400).joinToString("\n\n") { "paragraph $it with words to fill the line out" } +
        "\n\n| head a | head b |\n| --- | --- |\n| cell one | cell two |\n| cell three | four |\n\nend\n"

    @Test fun aDeletionAcrossATableRowsEdgeLeavesNoRowDrawnFromOldCells() = textFirstSession(note) { c ->
        val view = c.view
        withTimeout(30_000) { while (withContext(Dispatchers.Main) { !view.contentComplete }) delay(50) }
        val (start, end) = withContext(Dispatchers.Main) { view.editableText.let { it.indexOf("paragraph 1 ") + 5 to it.indexOf("cell one") + 3 } }
        c.select(start, end)
        withTimeout(5_000) { while (withContext(Dispatchers.Main) { view.selectionStart != start }) delay(20) }
        val stale = ArrayList<String>()
        var seen = false
        withContext(Dispatchers.Main) {
            view.onApplyMeasured = { _, update ->
                if (!seen && update.edits.isNotEmpty()) {
                    seen = true
                    val e = view.editableText
                    for (row in e.getSpans(0, e.length, TfTableRow::class.java)) {
                        val shift = e.getSpanStart(row) - row.displayStart
                        for (cell in row.row.cells) {
                            val at = cell.start + shift
                            val shown = if (at >= 0 && at + cell.text.length <= e.length) e.substring(at, at + cell.text.length) else "<out>"
                            if (shown != cell.text) stale += "row at ${e.getSpanStart(row)} cell \"${cell.text}\" over \"$shown\""
                        }
                    }
                }
            }
        }
        textFirstIme(c) { commitText("", 1) }
        withTimeout(10_000) { while (withContext(Dispatchers.Main) { !seen }) delay(20) }
        withContext(Dispatchers.Main) { view.onApplyMeasured = null }
        assertEquals("table rows drawn from the cells under them at the first apply", emptyList<String>(), stale)
        withTimeout(30_000) { while (withContext(Dispatchers.Main) { !view.contentComplete }) delay(50) }
        assertRendersAsFresh(c, "after the deletion")
    }
}
