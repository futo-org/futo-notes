package com.futo.notes.textfirst

import android.graphics.RectF
import uniffi.futo_notes_ffi.EditorTableAlignment

/** Geometry of the existing native grid, in the note view's viewport coordinates. */
internal data class TableCellGeometry(val bounds: RectF, val header: Boolean, val alignment: EditorTableAlignment,
    /** The cell's inline styling, and where the field's text starts in the cell's own text. */
    val runs: List<CellRun> = emptyList(), val runShift: Int = 0,
    /** The table's visible horizontal extent in the note view's coordinates: the open cell is clipped to it. */
    val visibleLeft: Float = 0f, val visibleRight: Float = 0f,
    /** The table's header line top, in the note view's coordinates (above the view's top once it has scrolled off). */
    val headerTop: Float = 0f)

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
    if (cell.start + rowStart - row.displayStart != target.contentStart) return null
    if (revealRow) revealLine(rowStart)
    if (revealColumn && row.revealColumn(column)) redrawTableRows { it.scroll === row.scroll }
    l = layout ?: return null
    val line = l.getLineForOffset(rowStart)
    val left = totalPaddingLeft + l.getLineLeft(line) + column * row.cellWidth - row.scroll.x - scrollX
    val top = totalPaddingTop + l.getLineTop(line) - scrollY
    val tableLeft = totalPaddingLeft + l.getLineLeft(line) - scrollX
    return TableCellGeometry(RectF(left, top.toFloat(), left + row.cellWidth,
        (totalPaddingTop + l.getLineBottom(line) - scrollY).toFloat()), row.row.header, row.row.cells[column].alignment,
        cell.runs, (target.contentStart - target.start).coerceAtLeast(0), tableLeft, tableLeft + row.viewportWidth,
        (totalPaddingTop + l.getLineTop(l.getLineForOffset(target.tableStart.coerceIn(0, e.length))) - scrollY).toFloat())
}

/** What a tap at ([x], [y]) on [row] means: the column it is in and, when it is on link text, the link. */
internal class TableTap(val column: Int, val cell: GridCell?, val link: CellRun?, val caret: Int)

internal fun TextFirstEditText.tableTapAt(row: TfTableRow, x: Float, y: Float): TableTap? {
    val l = layout ?: return null
    val e = editableText ?: return null
    val start = e.getSpanStart(row)
    if (start < 0) return null
    val line = l.getLineForOffset(start)
    val lineX = x - totalPaddingLeft + scrollX - l.getLineLeft(line)
    val column = row.columnAt(lineX)
    if (column < 0) return null
    val shift = start - row.displayStart
    val cell = row.row.cells.getOrNull(column)?.let { it.copy(start = it.start + shift, end = it.end + shift) }
    val left = totalPaddingLeft + l.getLineLeft(line) + column * row.cellWidth - row.scroll.x - scrollX
    val top = totalPaddingTop + l.getLineTop(line) - scrollY
    val rowHeight = l.getLineBottom(line) - l.getLineTop(line)
    val link = row.linkAt(column, x - left, y - top, rowHeight)
    val caret = cell?.let { (it.start + row.offsetIn(column, x - left, y - top, rowHeight)).coerceIn(it.start, it.end) } ?: 0
    return TableTap(column, cell, link, caret)
}

/** Whether [x] (in the note view) is over one of the table's boxes, one a short row lacks included. */
internal fun TextFirstEditText.tableBoxAt(row: TfTableRow, x: Float): Boolean {
    val l = layout ?: return false
    val start = editableText?.getSpanStart(row)?.takeIf { it >= 0 } ?: return false
    return row.columnAt(x - totalPaddingLeft + scrollX - l.getLineLeft(l.getLineForOffset(start))) >= 0
}
