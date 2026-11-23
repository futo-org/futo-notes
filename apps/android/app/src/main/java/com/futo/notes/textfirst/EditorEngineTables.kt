package com.futo.notes.textfirst

import uniffi.futo_notes_ffi.EditorByteRange
import uniffi.futo_notes_ffi.EditorProjection
import uniffi.futo_notes_ffi.EditorParagraphKey
import uniffi.futo_notes_ffi.EditorTableAlignment
import uniffi.futo_notes_ffi.EditorTableCommand
import uniffi.futo_notes_ffi.EditorTableControls
import uniffi.futo_notes_ffi.EditorSessionException
import uniffi.futo_notes_ffi.EditorTableDescription
import uniffi.futo_notes_ffi.EditorTableKey
import uniffi.futo_notes_ffi.EditorTableOutcome
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
    val composingStart: Int, val composingEnd: Int, val viewSeq: Int, val rowStart: Int, val column: Int, val contentStart: Int = start,
    /** The table's first display offset (its header line) and what the engine allows at this cell. */
    val tableStart: Int = 0, val controls: EditorTableControls? = null)

/** What the field last showed, on the editor thread: its extent keeps the spaces typed at the cell's edges. */
internal class CellWindow {
    var anchor = 0
    var length = 0
    var row = -1
    var column = -1
    var text = ""
    /** The engine's content end for the open cell: where a cell entered by a key puts the caret. */
    var contentEnd = 0
    /** Where the caret was when Delete table ran: Undo restores the deleted range as a selection, and the cell it came from opens. */
    var deletedFrom = -1
    fun clear() { row = -1; column = -1; text = ""; anchor = 0; length = 0; contentEnd = 0 }
}

/** How many spaces or tabs run from [at] in [step] direction (1: forward, -1: back from the character before [at]). */
private fun blankRun(text: CharSequence, at: Int, step: Int): Int {
    var n = 0
    var i = if (step > 0) at else at - 1
    while (i in text.indices && (text[i] == ' ' || text[i] == '\t')) { n++; i += step }
    return n
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
internal fun EditorEngine.tableTab(shift: Boolean): Boolean =
    tableKeyMove(if (shift) EditorTableKey.SHIFT_TAB else EditorTableKey.TAB)

internal fun EditorEngine.tableKeyMove(key: EditorTableKey): Boolean = applyTableOutcome(session?.tableKey(rev, key))

/** A table key's or entered cell's outcome applied: an accepted edit, or a selection move. False when there was none. */
private fun EditorEngine.applyTableOutcome(outcome: EditorTableOutcome?): Boolean {
    outcome ?: return false
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
    // A composition replaces what was selected, edge spaces the engine's content leaves out included: the window
    // always covers the marked text (it would otherwise come out empty, with the composition outside it).
    val start = minOf(canonical.start.toInt(), overlay?.start ?: Int.MAX_VALUE)
    val end = maxOf(canonical.end.toInt() + (overlay?.let { it.marked.length - it.original.length } ?: 0),
        overlay?.let { it.start + it.marked.length } ?: 0)
    val text = mirror.text
    val w = cellWindow
    val row = selected.row.toInt()
    val column = selected.column.toInt()
    val same = w.row == row && w.column == column
    // The field keeps the spaces typed at the cell's edges: its extent stays put while the display over it
    // still reads as that extent around the engine's content; otherwise it is rebuilt around the content,
    // keeping the edge spaces the field showed or that the caret stands in (one padding space aside).
    val held = same && w.anchor <= start && end <= w.anchor + w.length && w.anchor + w.length <= text.length &&
        blank(text, w.anchor, start) && blank(text, end, w.anchor + w.length)
    // Of the spaces around the content, the row's own padding (one each side) is never the field's: only the ones
    // beyond it were typed here. A content that shrank (a Backspace) leaves the old window over that padding.
    val keptFrom = if (held) maxOf(w.anchor, start - maxOf(0, blankRun(text, start, -1) - 1)) else start
    val keptTo = if (held) minOf(w.anchor + w.length, end + maxOf(0, blankRun(text, end, 1) - 1)) else end
    val keep = held && mirror.selStart >= keptFrom && mirror.selEnd <= keptTo
    var from = start
    var to = end
    if (keep) {
        from = keptFrom; to = keptTo
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
        seq, rowStart, column, contentStart = canonical.start.toInt(),
        tableStart = mirror.toUtf16(table.display.start.toInt()), controls = table.controls)
    ui.post { sink.onCell(update) }
}

/** A row or column command at the open cell: one accepted edit, one Undo step; the field follows the engine's selection. */
internal fun EditorEngine.tableCommand(which: EditorTableCommand) = command {
    val s = session ?: return@command
    if (!editingCell) return@command
    if (mirror.overlay != null) commitComposition(null)
    val change = s.tableCommand(rev, mirror.byteRange(mirror.selStart, mirror.selEnd), which) ?: return@command
    accept(change)
}

/**
 * Delete table, by the engine's rule: Backspace over the range from the first header cell to the last cell, through
 * the ordinary deletion path (one edit, one Undo step). The field closes first: it has no cell left to stand for.
 */
internal fun EditorEngine.deleteTable() = command {
    val s = session ?: return@command
    if (!editingCell) return@command
    if (mirror.overlay != null) commitComposition(null)
    val table = s.inspectTable(rev, mirror.byteRange(mirror.selStart, mirror.selEnd)) ?: return@command
    val first = table.rows.firstOrNull()?.firstOrNull() ?: return@command
    val last = table.rows.lastOrNull()?.lastOrNull() ?: return@command
    // A selection inside one cell edits its text: with a single cell the range takes the leading pipe too.
    val oneCell = table.rows.size == 1 && table.rows[0].size == 1
    cellWindow.deletedFrom = mirror.selStart
    val start = (if (oneCell) s.displayToUtf16(rev, table.display) else s.displayToUtf16(rev, first.content)).start.toInt()
    val end = s.displayToUtf16(rev, last.content).end.toInt()
    editingCell = false
    cellRange = null
    cellWindow.clear()
    ui.post { sink.onCell(null, true) }
    // The range goes to the key itself, so the caret stays in the cell the table is deleted from: Undo puts it back there.
    checkNotNull(fast).paragraphKey(rev, start, end, EditorParagraphKey.BACKSPACE_JOINING_HEADING)?.let(::accept)
}

/**
 * A tap in a box a short row draws but lacks: the engine enters the cell by its row and column, giving the row its
 * missing cells in ONE edit, and the field opens there. The row is named by [rowStart], a display offset in the
 * view update [viewSeq]. [done] says whether a cell opened.
 */
internal fun EditorEngine.openMissingCell(rowStart: Int, column: Int, viewSeq: Int, done: (Boolean) -> Unit) {
    val posted = handler.post {
        var opened = false
        try {
            val s = session
            val at = viewEdits.map(viewSeq, rowStart, rowStart)?.first
            if (!closed && s != null && at != null && storageGate?.isMigrationStarted != true) {
                if (mirror.overlay != null) commitComposition(null)
                editingCell = true
                opened = applyTableOutcome(s.enterTableCell(rev, mirror.byteRange(at, at).start, column.toUInt()))
                if (!opened) { editingCell = false; cellRange = null; cellWindow.clear(); ui.post { sink.onCell(null) } }
            }
        } catch (e: EditorSessionException) {
            handleFailure(e)
        } finally { ui.post { done(opened) } }
    }
    if (!posted) ui.post { done(false) }
}

/**
 * The engine's selection is in a table cell but no field is open (Undo or Redo brought a table back; the keystroke that
 * finishes a hand-typed delimiter row put the caret in the first body cell): open the field there, as a tap would.
 */
internal fun EditorEngine.openCellAtSelection(restoreRange: Boolean = false) {
    if (editingCell || mirror.overlay != null) return
    val s = session ?: return
    var table = s.inspectTable(rev, mirror.byteRange(mirror.selStart, mirror.selEnd)) ?: return
    if (table.focus == null) {
        if (!restoreRange) return
        // Undo of Delete table restores the deleted range as the selection: the caret goes back to the cell it was deleted from.
        val extent = s.displayToUtf16(rev, table.display)
        if (mirror.selStart == mirror.selEnd || mirror.selStart < extent.start.toInt() || mirror.selEnd > extent.end.toInt()) return
        val first = table.rows.firstOrNull()?.firstOrNull() ?: return
        val at = cellWindow.deletedFrom.takeIf { it in extent.start.toInt()..extent.end.toInt() }
            ?: s.displayToUtf16(rev, first.content).start.toInt()
        select(at, at, fromView = false)
        table = s.inspectTable(rev, mirror.byteRange(mirror.selStart, mirror.selEnd)) ?: return
        if (table.focus == null) return
    }
    editingCell = true
    publishCell()
}
