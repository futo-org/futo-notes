package com.futo.notes.textfirst

import uniffi.futo_notes_ffi.EditorByteRange
import uniffi.futo_notes_ffi.EditorProjection
import uniffi.futo_notes_ffi.EditorTableAlignment
import uniffi.futo_notes_ffi.EditorUtf16Range

/** Display coordinates supplied by Rust. Never source coordinates or Markdown fragments. */
internal data class GridCell(val start: Int, val end: Int, val text: String, val alignment: EditorTableAlignment)
internal data class GridRow(val cells: List<GridCell>, val columns: Int, val header: Boolean, val tableStart: Int)
internal data class CellUpdate(val start: Int, val end: Int, val text: String, val selectionStart: Int, val selectionEnd: Int,
    val composingStart: Int, val composingEnd: Int)

/** Inspect only projected blocks, skipping every block already covered by a returned table. */
internal fun EditorEngine.tableSpans(p: EditorProjection): List<SpanSpec> {
    val s = session ?: return emptyList()
    val out = ArrayList<SpanSpec>()
    var covered = -1
    for (block in p.blocks) {
        val at = mirror.toUtf16(block.range.start.toInt())
        if (at < covered) continue
        val table = s.inspectTable(rev, EditorByteRange(block.range.start, block.range.start)) ?: continue
        val tableStart = mirror.toUtf16(table.display.start.toInt())
        covered = mirror.toUtf16(table.display.end.toInt())
        for ((i, row) in table.rows.withIndex()) {
            val cells = row.map { cell ->
                val a = mirror.toUtf16(cell.content.start.toInt())
                val b = mirror.toUtf16(cell.content.end.toInt())
                GridCell(a, b, mirror.text.substring(a, b), table.alignments[cell.column.toInt()])
            }
            if (cells.isEmpty()) continue
            val a = mirror.text.lastIndexOf('\n', (cells.first().start - 1).coerceAtLeast(0)).let { if (it < 0) 0 else it + 1 }
            val b = mirror.text.indexOf('\n', cells.last().end).let { if (it < 0) mirror.text.length else it }
            out += SpanSpec.TableRow(a, b, GridRow(cells, table.columns.toInt(), i == 0, tableStart))
            if (i == 0 && b < mirror.text.length) {
                val delimiterEnd = mirror.text.indexOf('\n', b + 1).let { if (it < 0) mirror.text.length else it }
                out += SpanSpec.TableDelimiter(b + 1, delimiterEnd)
            }
        }
    }
    return out
}

/** Used by a grid tap and Find alike: the selected range is the actual displayed range. */
internal fun EditorEngine.selectDisplayRange(start: Int, end: Int, expectedSeq: Int? = null, done: (Boolean) -> Unit) {
    val posted = handler.post {
        var selected = false
        try {
            if (!closed && session != null && storageGate?.isMigrationStarted != true && (expectedSeq == null || expectedSeq == seq)) {
                if (mirror.overlay != null) commitComposition(null)
                showDisplayRange(start, end)
                selected = true
            }
        } catch (e: uniffi.futo_notes_ffi.EditorSessionException) {
            handleFailure(e)
        } finally { ui.post { done(selected) } }
    }
    if (!posted) ui.post { done(false) }
}

/** Select a display range, opening the cell field when it lies in a table cell. Editor thread, no composition. */
internal fun EditorEngine.showDisplayRange(start: Int, end: Int) {
    val s = checkNotNull(session)
    val table = s.inspectTable(rev, mirror.byteRange(start, end))
    editingCell = table?.focus != null
    select(start, end, fromView = false)
    if (editingCell) publishCell() else { cellRange = null; ui.post { sink.onCell(null) } }
}

internal fun EditorEngine.finishCellEditing() = command {
    if (mirror.overlay != null) commitComposition(null)
    editingCell = false
    cellRange = null
    ui.post { sink.onCell(null) }
}

/** Reinspect after accepted edits/Undo/adoption; composition only shifts the displayed cell end. */
internal fun EditorEngine.publishCell() {
    if (!editingCell) return
    val s = session ?: return
    val overlay = mirror.overlay
    val a = overlay?.start ?: mirror.selStart
    val b = if (overlay != null) overlay.start + overlay.original.length else mirror.selEnd
    val table = s.inspectTable(rev, s.utf16ToDisplay(rev, EditorUtf16Range(a.toULong(), b.toULong())))
    val focus = table?.focus
    val cell = focus?.let { table.rows.getOrNull(it.row.toInt())?.getOrNull(it.column.toInt()) }
    if (cell == null) {
        editingCell = false; cellRange = null
        ui.post { sink.onCell(null) }
        return
    }
    val canonical = s.displayToUtf16(rev, cell.content)
    val start = canonical.start.toInt()
    val end = canonical.end.toInt() + (overlay?.let { it.marked.length - it.original.length } ?: 0)
    cellRange = start..end
    val update = CellUpdate(start, end, mirror.text.substring(start, end), mirror.selStart - start, mirror.selEnd - start,
        if (overlay != null) overlay.start - start else -1, if (overlay != null) overlay.start - start + overlay.marked.length else -1)
    ui.post { sink.onCell(update) }
}
