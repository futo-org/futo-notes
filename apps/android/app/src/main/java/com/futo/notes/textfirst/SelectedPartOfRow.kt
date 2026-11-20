package com.futo.notes.textfirst

/**
 * A visual row of the note's text: offsets [start, end), [visibleEnd] where its text ends (before trailing spaces and
 * its line break), [endsWithBreak] when it ends its paragraph with a line break (not a soft wrap, not the note's last line).
 */
internal data class TextRow(val start: Int, val end: Int, val visibleEnd: Int, val endsWithBreak: Boolean)

/** A row's part of a selection: its text [from, to), none when they are equal, and [breakAt], where its selected line break is shown. */
internal data class RowSelection(val from: Int, val to: Int, val breakAt: Int?)

/**
 * What [row] shows of the selection [selectionStart, selectionEnd): the text it covers and, when the row's line break
 * is selected, a space's width of tint after the row's text, as desktop shows it. Null when it shows nothing.
 */
internal fun selectedPartOfRow(row: TextRow, selectionStart: Int, selectionEnd: Int): RowSelection? {
    val from = maxOf(selectionStart, row.start)
    val to = maxOf(from, minOf(selectionEnd, row.visibleEnd))
    val breakAt = if (row.endsWithBreak && selectionStart < row.end && selectionEnd >= row.end) row.visibleEnd else null
    if (from == to && breakAt == null) return null
    return RowSelection(from, to, breakAt)
}

internal fun lineBreakTintEdges(x: Float, spaceWidth: Float, rightToLeft: Boolean): Pair<Float, Float> =
    if (rightToLeft) (x - spaceWidth) to x else x to (x + spaceWidth)
