package com.futo.notes.textfirst

import uniffi.futo_notes_ffi.EditorListMarker
import uniffi.futo_notes_ffi.EditorStyleSpan

/**
 * The engine's style plan for [start, end) of [display] as a restyle window. A plan that meets a
 * table's header or delimiter holds the whole table, so the window grows to cover every span:
 * an old span is then replaced rather than kept beside the new one.
 */
internal fun List<EditorStyleSpan>.toStyleWindow(start: Int, end: Int, display: CharSequence): StyleWindow {
    val languages = filterIsInstance<EditorStyleSpan.CodeBlock>().associate { it.start to it.language }
    val (grid, text) = mapNotNull { it.toSpanSpec(display, languages) }
        .partition { it is SpanSpec.TableRow || it is SpanSpec.TableDelimiter }
    // Grid rows are disjoint lines in document order, so the row a span could sit in is the last one starting at or before it.
    val rows = grid.sortedBy { it.start }
    val specs = text.filter { spec ->
        val i = rows.binarySearchBy(spec.start) { it.start }.let { if (it >= 0) it else -it - 2 }
        i < 0 || spec.end > rows[i].end
    } + grid
    return StyleWindow(minOf(start, specs.minOfOrNull { it.start } ?: start), maxOf(end, specs.maxOfOrNull { it.end } ?: end), specs)
}

/** A block's first code line starts where the block does, so [languages] is keyed by block start. */
private fun EditorStyleSpan.toSpanSpec(display: CharSequence, languages: Map<ULong, String?>): SpanSpec? = when (this) {
    is EditorStyleSpan.Inline -> SpanSpec.Inline(start.toInt(), end.toInt(), bold, italic, strike, code)
    is EditorStyleSpan.Heading -> SpanSpec.Heading(start.toInt(), end.toInt(), level.toInt())
    is EditorStyleSpan.Quote -> SpanSpec.Quote(start.toInt(), end.toInt(), depth.toInt())
    is EditorStyleSpan.ListRow -> toListSpec()
    is EditorStyleSpan.Code -> SpanSpec.Code(start.toInt(), end.toInt(), if (first) languages[start] else null)
    is EditorStyleSpan.CodeBlock -> null
    is EditorStyleSpan.Metadata -> SpanSpec.Metadata(start.toInt(), end.toInt())
    is EditorStyleSpan.Link -> SpanSpec.Link(start.toInt(), end.toInt(), destination)
    is EditorStyleSpan.Wikilink -> SpanSpec.Wikilink(start.toInt(), end.toInt(), label, noteId)
    is EditorStyleSpan.Tag -> SpanSpec.Tag(start.toInt(), end.toInt())
    is EditorStyleSpan.Divider -> SpanSpec.Divider(start.toInt(), end.toInt())
    is EditorStyleSpan.Image -> SpanSpec.Image(start.toInt(), end.toInt(), destination, alt, vault, remote)
    is EditorStyleSpan.TableRow -> toTableSpec(display)
    is EditorStyleSpan.TableDelimiter -> SpanSpec.TableDelimiter(start.toInt(), end.toInt())
}

private fun EditorStyleSpan.ListRow.toListSpec(): SpanSpec {
    val depth = level.toInt()
    val kind = when (marker) {
        EditorListMarker.PLAIN -> return SpanSpec.Indent(start.toInt(), end.toInt(), depth)
        EditorListMarker.BULLET -> ListMarker.Bullet
        EditorListMarker.ORDERED -> ListMarker.Ordered
        EditorListMarker.TASK -> ListMarker.Task
    }
    return SpanSpec.ListRow(start.toInt(), end.toInt(), depth, kind, text, checked, first)
}

/** A cell's text is read from the display: the engine names only its range. */
private fun EditorStyleSpan.TableRow.toTableSpec(display: CharSequence): SpanSpec? {
    if (cells.isEmpty()) return null
    val row = cells.map { cell ->
        val cellStart = cell.start.toInt()
        val cellEnd = cell.end.toInt()
        GridCell(cellStart, cellEnd, display.substring(cellStart, cellEnd), cell.alignment)
    }
    return SpanSpec.TableRow(start.toInt(), end.toInt(), GridRow(row, columns.toInt(), header, tableStart.toInt()))
}
