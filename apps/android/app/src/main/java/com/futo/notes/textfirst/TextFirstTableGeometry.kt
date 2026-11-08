package com.futo.notes.textfirst

import android.graphics.RectF
import uniffi.futo_notes_ffi.EditorTableAlignment

/** Geometry of the existing native grid, in the note view's viewport coordinates. */
internal data class TableCellGeometry(val bounds: RectF, val header: Boolean, val alignment: EditorTableAlignment)

internal fun TextFirstEditText.tableRowAt(y: Float): TfTableRow? {
    val l = layout ?: return null
    val vertical = y - totalPaddingTop + scrollY
    if (vertical < 0 || vertical >= l.height) return null
    val at = l.getLineStart(l.getLineForVertical(vertical.toInt()))
    val e = editableText ?: return null
    return e.getSpans(at, at, TfTableRow::class.java).firstOrNull {
        e.getSpanStart(it) <= at && e.getSpanEnd(it) > at
    }
}

internal fun TextFirstEditText.tableCellAt(row: TfTableRow, x: Float): GridCell? {
    val l = layout ?: return null
    val e = editableText ?: return null
    val start = e.getSpanStart(row)
    if (start < 0) return null
    val line = l.getLineForOffset(start)
    val cell = row.cellAt(x - totalPaddingLeft + scrollX - l.getLineLeft(line)) ?: return null
    val shift = start - row.displayStart
    return cell.copy(start = cell.start + shift, end = cell.end + shift)
}

/** Match canonical row/column identity, including adjacent empty cells with equal boundaries. */
internal fun TextFirstEditText.tableCellGeometry(target: CellUpdate, revealRow: Boolean, revealColumn: Boolean): TableCellGeometry? {
    val e = editableText ?: return null
    val rowStart = target.rowStart
    if (rowStart !in 0 until e.length) return null
    var l = layout ?: return null
    val row = e.getSpans(rowStart, rowStart, TfTableRow::class.java).firstOrNull {
        e.getSpanStart(it) == rowStart
    } ?: return null
    val column = target.column
    val cell = row.row.cells.getOrNull(column) ?: return null
    if (cell.start + rowStart - row.displayStart != target.start) return null
    if (revealRow) revealLine(rowStart)
    if (revealColumn && row.revealColumn(column)) redrawTableRows { it.scroll === row.scroll }
    l = layout ?: return null
    val line = l.getLineForOffset(rowStart)
    val left = totalPaddingLeft + l.getLineLeft(line) + column * row.cellWidth - row.scroll.x - scrollX
    val top = totalPaddingTop + l.getLineTop(line) - scrollY
    return TableCellGeometry(RectF(left, top.toFloat(), left + row.cellWidth,
        (totalPaddingTop + l.getLineBottom(line) - scrollY).toFloat()), row.row.header, row.row.cells[column].alignment)
}
