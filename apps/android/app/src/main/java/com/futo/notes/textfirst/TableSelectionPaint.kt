package com.futo.notes.textfirst

import android.graphics.Canvas

/**
 * A selection over table rows: the TextView's own highlight would run each row out to the note's edge under the grid's
 * opaque cells, so it is hidden (refreshCodeHighlight) and painted here instead. Rows outside the table keep the
 * selection's usual rows; each table row the selection touches tints its cells, clipped to the table's columns.
 */
internal fun TextFirstEditText.selectedTableRows(): List<TfTableRow> {
    val e = editableText ?: return emptyList()
    val start = minOf(selectionStart, selectionEnd)
    val end = maxOf(selectionStart, selectionEnd)
    if (start < 0 || start >= end) return emptyList()
    return e.getSpans(start, end, TfTableRow::class.java).filter { span ->
        val shift = e.getSpanStart(span) - span.displayStart
        // A selection inside one cell is that cell's own (its field shows it), not a selection over the row.
        e.getSpanStart(span) < end && e.getSpanEnd(span) > start && span.row.cells.none { start >= it.start + shift && end <= it.end + shift }
    }
}

/** The selection's part on screen: a whole-note selection is not walked line by line on every frame. */
private fun TextFirstEditText.visibleSelection(): IntRange? {
    val l = layout ?: return null
    val top = scrollY - totalPaddingTop
    val start = maxOf(minOf(selectionStart, selectionEnd), l.getLineStart(l.getLineForVertical(maxOf(0, top))))
    val end = minOf(maxOf(selectionStart, selectionEnd), l.getLineEnd(l.getLineForVertical(maxOf(0, top + height))))
    return if (start < end) start..end else null
}

/** The selection's rows outside its table rows, under the text, as the TextView would paint them. */
internal fun TextFirstEditText.drawTableSelectionUnder(canvas: Canvas) {
    if (codeSelection != null) return
    val rows = selectedTableRows().ifEmpty { return }
    val l = layout ?: return
    val e = editableText ?: return
    val paint = codeChrome.selectionPaint.apply { color = this@drawTableSelectionUnder.style.selectionColor }
    val save = canvas.save()
    canvas.translate(totalPaddingLeft.toFloat(), totalPaddingTop.toFloat())
    val shown = visibleSelection() ?: return canvas.restoreToCount(save)
    var from = shown.first
    // One stretch per table: its rows, the hidden delimiter row between them and the line break after the last.
    for (table in rows.groupBy { it.row.tableStart }.values) {
        val start = table.minOf { e.getSpanStart(it) }
        var end = table.maxOf { e.getSpanEnd(it) }
        if (end < e.length && e[end] == '\n') end++
        if (end <= shown.first || start >= shown.last) continue
        drawSelectionRows(canvas, l, e, from, start, paint)
        from = maxOf(from, end)
    }
    drawSelectionRows(canvas, l, e, from, shown.last, paint)
    canvas.restoreToCount(save)
}

/** Each selected table row's cells, over the grid (its header fill is opaque), clipped to the columns and the note. */
internal fun TextFirstEditText.drawTableSelectionOver(canvas: Canvas) {
    if (codeSelection != null) return
    val rows = selectedTableRows().ifEmpty { return }
    val l = layout ?: return
    val e = editableText ?: return
    val paint = codeChrome.selectionPaint.apply { color = this@drawTableSelectionOver.style.selectionColor }
    val save = canvas.save()
    canvas.translate(totalPaddingLeft.toFloat(), totalPaddingTop.toFloat())
    val shown = visibleSelection() ?: return canvas.restoreToCount(save)
    for (row in rows) {
        val start = e.getSpanStart(row)
        if (e.getSpanEnd(row) <= shown.first || start >= shown.last) continue
        val line = l.getLineForOffset(start)
        // The grid as drawn: its start is its right side in a right-to-left row.
        val x = l.getPrimaryHorizontal(start)
        val left = if (l.isRtlCharAt(start)) x - row.drawnWidth else x
        val right = minOf(left - row.scroll.x + row.row.columns * row.cellWidth, left + row.drawnWidth)
        if (right > left) canvas.drawRect(left, l.getLineTop(line).toFloat(), right, l.getLineBottom(line).toFloat(), paint)
    }
    canvas.restoreToCount(save)
}
