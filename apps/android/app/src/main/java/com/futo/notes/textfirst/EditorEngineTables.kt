package com.futo.notes.textfirst

import uniffi.futo_notes_ffi.EditorParagraphKey
import uniffi.futo_notes_ffi.EditorTableAlignment
import uniffi.futo_notes_ffi.EditorTableKey
import uniffi.futo_notes_ffi.EditorUtf16Range

/** Display coordinates supplied by Rust. Never source coordinates or Markdown fragments. */
internal data class GridCell(val start: Int, val end: Int, val text: String, val alignment: EditorTableAlignment, val runs: List<CellRun> = emptyList())
/** The engine's inline styling over part of a cell's text, relative to the cell's start; a link or wikilink says where it goes. */
internal data class CellRun(val start: Int, val end: Int, val bold: Boolean = false, val italic: Boolean = false, val strike: Boolean = false,
    val code: Boolean = false, val link: String? = null, val wiki: Boolean = false, val noteId: String? = null)
internal data class GridRow(val cells: List<GridCell>, val columns: Int, val header: Boolean, val tableStart: Int)
/**
 * The field's window onto the note: [start]..[end] is the display slice the field's [text] shows, and every
 * offset below is relative to [start]. [contentStart] is where the engine's cell content (edge spaces
 * excluded) starts. The keyboard reads the same window (EngineInputConnection), so it and the field agree.
 */
internal data class CellUpdate(val start: Int, val end: Int, val text: String, val selectionStart: Int, val selectionEnd: Int,
    val composingStart: Int, val composingEnd: Int, val viewSeq: Int, val rowStart: Int, val column: Int, val contentStart: Int = start)

/** What the field last showed, on the editor thread: its extent keeps the spaces typed at the cell's edges. */
internal class CellWindow {
    var anchor = 0
    var length = 0
    var row = -1
    var column = -1
    var text = ""
    /** The engine's content end for the open cell: where a cell entered by a key puts the caret. */
    var contentEnd = 0
    fun clear() { row = -1; column = -1; text = ""; anchor = 0; length = 0; contentEnd = 0 }
}

private fun blank(text: CharSequence, from: Int, to: Int): Boolean {
    if (from < 0 || from > to || to > text.length) return false
    for (i in from until to) if (text[i] != ' ' && text[i] != '\t') return false
    return true
}

/**
 * Used by a grid tap and Find alike: the selected range is the actual displayed range.
 * A grid tap names the view update it saw ([viewSeq]); like any tap it is carried through
 * the updates still on their way to the view rather than dropped.
 */
internal fun EditorEngine.selectDisplayRange(start: Int, end: Int, viewSeq: Int? = null, done: (Boolean) -> Unit) {
    val posted = handler.post {
        var selected = false
        try {
            val range = if (viewSeq == null) start to end else viewEdits.map(viewSeq, start, end)
            if (!closed && session != null && storageGate?.isMigrationStarted != true && range != null) {
                if (mirror.overlay != null) commitComposition(null)
                showDisplayRange(range.first, range.second)
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
    if (!editingCell) cellWindow.clear()
    select(start, end, fromView = false)
    if (editingCell) publishCell() else { cellRange = null; ui.post { sink.onCell(null) } }
}

internal fun EditorEngine.finishCellEditing() = command {
    if (mirror.overlay != null) commitComposition(null)
    editingCell = false
    cellRange = null
    cellWindow.clear()
    ui.post { sink.onCell(null) }
}

/**
 * Ctrl+Enter in a cell (desktop's Mod+Enter): editing leaves the table for an empty line after it, the line after the
 * table when that is empty, else a new one opened before that line (Enter at its start, so its own rules hold).
 */
internal fun EditorEngine.leaveTableBelow() = command {
    if (mirror.overlay != null) commitComposition(null)
    val s = session ?: return@command
    val table = s.inspectTable(rev, mirror.byteRange(mirror.selStart, mirror.selStart)) ?: return@command
    val text = mirror.text
    val tableStart = mirror.toUtf16(table.display.start.toInt())
    var tableEnd = mirror.toUtf16(table.display.end.toInt())
    if (tableEnd > tableStart && text[tableEnd - 1] == '\n') tableEnd--
    editingCell = false; cellWindow.clear()
    cellRange = null
    ui.post { sink.onCell(null) }
    if (tableEnd >= text.length) {
        select(tableEnd, tableEnd, fromView = false)
        key(EditorParagraphKey.ENTER)
        return@command
    }
    val next = tableEnd + 1
    select(next, next, fromView = false)
    if (next >= text.length || text[next] == '\n') return@command
    key(EditorParagraphKey.ENTER)
    select(next, next, fromView = false)
}

/** Tab navigation and row insertion are one canonical table-key outcome. */
internal fun EditorEngine.tableTab(shift: Boolean): Boolean {
    val outcome = session?.tableKey(rev, if (shift) EditorTableKey.SHIFT_TAB else EditorTableKey.TAB)
        ?: return false
    outcome.edited?.let { accept(it) }
    outcome.selected?.let {
        if (streaming && mirror.toUtf16(it.selection.end.toInt()) > tailStart()) finishStreaming()
        applySelectionChange(it)
        postUpdate(emptyList(), emptyList())
    }
    collapseCellCaret()
    return true
}

/** A cell the keys arrive in has its caret at the end of its text, nothing selected (as a tap leaves a caret, not a range). */
internal fun EditorEngine.collapseCellCaret() {
    if (!editingCell || mirror.overlay != null) return
    val end = cellWindow.contentEnd
    if (mirror.selStart != end || mirror.selEnd != end) select(end, end, fromView = false)
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
        editingCell = false; cellRange = null; cellWindow.clear()
        val toNote = writesDelimiterRow
        ui.post { sink.onCell(null, toNote) }
        return
    }
    val selected = checkNotNull(focus)
    val rowStart = mirror.toUtf16(checkNotNull(table).rowLines[selected.row.toInt()].start.toInt())
    val canonical = s.displayToUtf16(rev, cell.content)
    val start = canonical.start.toInt()
    val end = canonical.end.toInt() + (overlay?.let { it.marked.length - it.original.length } ?: 0)
    val text = mirror.text
    val w = cellWindow
    val row = selected.row.toInt()
    val column = selected.column.toInt()
    val same = w.row == row && w.column == column
    // The field keeps the spaces typed at the cell's edges: its extent stays put while the display over it
    // still reads as that extent around the engine's content; otherwise it is rebuilt around the content,
    // keeping the edge spaces the field showed or that the caret stands in (one padding space aside).
    val keep = same && w.anchor <= start && end <= w.anchor + w.length && w.anchor + w.length <= text.length &&
        blank(text, w.anchor, start) && blank(text, end, w.anchor + w.length)
    var from = start
    var to = end
    if (keep) {
        from = w.anchor; to = w.anchor + w.length
    } else if (same) {
        val old = w.text
        val trail = old.length - old.trimEnd(' ', '\t').length
        val lead = if (trail == old.length) 0 else old.length - old.trimStart(' ', '\t').length
        val left = maxOf(lead, start - mirror.selStart)
        val right = maxOf(trail, mirror.selEnd - end)
        if (left > 0 && blank(text, start - left - 1, start)) from = start - left
        if (right > 0 && blank(text, end, end + right + 1)) to = end + right
    }
    val shown = text.substring(from, to)
    w.row = row; w.column = column; w.anchor = from; w.length = to - from; w.text = shown; w.contentEnd = end
    cellRange = from..to
    val update = CellUpdate(from, to, shown, mirror.selStart - from, mirror.selEnd - from,
        if (overlay != null) overlay.start - from else -1, if (overlay != null) overlay.start - from + overlay.marked.length else -1,
        seq, rowStart, column, contentStart = start)
    ui.post { sink.onCell(update) }
}
