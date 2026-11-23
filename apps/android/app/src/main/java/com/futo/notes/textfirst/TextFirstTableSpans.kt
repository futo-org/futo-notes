package com.futo.notes.textfirst

import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.graphics.Region
import android.text.Layout
import android.text.Spanned
import android.text.StaticLayout
import android.text.TextPaint
import android.text.style.CharacterStyle
import android.text.style.LineHeightSpan
import android.text.style.ReplacementSpan
import android.text.style.UpdateAppearance
import uniffi.futo_notes_ffi.EditorTableAlignment

/**
 * What every row of one table shares: the sideways offset and the table's column count (the engine's table-wide
 * count; a row the engine did not describe again after a `|` was typed must still be drawn at the new width).
 */
internal class TableScroll {
    var x = 0f
    var columns = 0
    /** The column count changed under rows that were not rebuilt: they must be measured again. */
    var dirty = false
}

/** Column width: at least 110 dp, and the table fills the note's width when it has few columns. */
internal fun tableColumnWidth(look: TextFirstStyle, noteWidth: Int, columns: Int): Float =
    maxOf(look.dp(110f), noteWidth.toFloat() / maxOf(1, columns))

/**
 * The engine plans only the table rows a window meets, and a row's `tableStart` is where its
 * table starts now; rows it did not plan keep the key they were drawn with. A body row takes the
 * key of the row above it, so a table keeps one key (one sideways scroll). A header, which every
 * whole-table plan includes, mints it: [mintedKeys] are the tables whose header is being added.
 * Rows are added in document order, so the row above is already in place.
 */
internal fun Spanned.keyedToTableAbove(spec: SpanSpec, mintedKeys: Set<Int>): SpanSpec {
    if (spec !is SpanSpec.TableRow || spec.row.header || spec.row.tableStart in mintedKeys) return spec
    val key = tableKeyAbove(spec.start) ?: return spec
    if (key == spec.row.tableStart) return spec
    return SpanSpec.TableRow(spec.start, spec.end, spec.row.copy(tableStart = key))
}

internal fun mintedTableKeys(specs: List<SpanSpec>): Set<Int> {
    if (specs.none { it is SpanSpec.TableRow }) return emptySet()
    return specs.mapNotNullTo(HashSet()) { spec -> (spec as? SpanSpec.TableRow)?.row?.takeIf { it.header }?.tableStart }
}

/** The key of the table row on the line before [rowStart], looking through the delimiter line to the header. */
private fun Spanned.tableKeyAbove(rowStart: Int): Int? {
    var at = rowStart
    repeat(2) {
        if (at <= 0) return null
        val line = lastIndexOf('\n', at - 2) + 1
        getSpans(line, at, TfTableRow::class.java).firstOrNull { getSpanStart(it) == line }?.let { return it.row.tableStart }
        if (getSpans(line, at, TfTableDelimiter::class.java).none { getSpanStart(it) == line }) return null
        at = line
    }
    return null
}

/** One physical row, drawn from canonical cell descriptions. Width and scrolling are view concerns. */
internal class TfTableRow(
    private val look: TextFirstStyle,
    val row: GridRow,
    val displayStart: Int,
    val scroll: TableScroll,
    private val marks: FindMarks,
    private val width: () -> Int,
) : ReplacementSpan(), TfAtom {
    init {
        if (scroll.columns != 0 && scroll.columns != row.columns) scroll.dirty = true
        scroll.columns = row.columns
    }
    val columns: Int get() = scroll.columns
    val viewportWidth: Int get() = width()
    val cellWidth: Float get() = tableColumnWidth(look, width(), columns)
    private val padding = look.dp(10f)

    private class Built(val cellWidth: Float, val layouts: List<StaticLayout>, val height: Int)
    private var built: Built? = null
    private fun build(): Built {
        val cw = cellWidth
        built?.takeIf { it.cellWidth == cw }?.let { return it }
        val layouts = row.cells.map { cell ->
            val paint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
                textSize = look.textSizePx; color = look.textColor
                typeface = if (row.header) look.semibold else look.regular
            }
            val text = styledCellText(look, cell.text, cell.runs, 0)
            StaticLayout.Builder.obtain(text, 0, text.length, paint, (cw - padding * 2).toInt().coerceAtLeast(1))
                .setAlignment(when (cell.alignment) {
                    EditorTableAlignment.RIGHT -> Layout.Alignment.ALIGN_OPPOSITE
                    EditorTableAlignment.CENTER -> Layout.Alignment.ALIGN_CENTER
                    else -> Layout.Alignment.ALIGN_NORMAL
                }).setIncludePad(false).build()
        }
        val height = maxOf(look.dp(48f).toInt(), (layouts.maxOfOrNull { it.height } ?: 0) + (padding * 2).toInt())
        return Built(cw, layouts, height).also { built = it }
    }
    /** Text edits above this row shift all its offsets without changing any cell layout. */
    fun matches(next: GridRow, nextStart: Int): Boolean {
        // Keep the factory's table-scroll identity when a table itself moves.
        if (row.tableStart != next.tableStart || row.header != next.header ||
            row.columns != next.columns || row.cells.size != next.cells.size) return false
        val shift = nextStart - displayStart
        return row.cells.indices.all { i ->
            val old = row.cells[i]
            val cell = next.cells[i]
            old.start + shift == cell.start && old.end + shift == cell.end &&
                old.text == cell.text && old.alignment == cell.alignment && old.runs == cell.runs
        }
    }

    override fun getSize(paint: Paint, text: CharSequence, start: Int, end: Int, fm: Paint.FontMetricsInt?): Int {
        val rowHeight = build().height
        fm?.apply { ascent = -(rowHeight - look.bodyLineSpacing); top = ascent; descent = 0; bottom = 0 }
        // As wide as the table, the note's width at most: a row's end (a selection handle there) is the table's edge.
        return drawnWidth
    }
    /** How wide the row is drawn: the table, the note's width at most. */
    val drawnWidth: Int get() = minOf(width(), kotlin.math.ceil(columns * cellWidth).toInt())
    override fun draw(canvas: Canvas, text: CharSequence, start: Int, end: Int, x: Float, top: Int, y: Int, bottom: Int, paint: Paint) {
        val built = build()
        val cellWidth = built.cellWidth
        val save = canvas.save()
        canvas.clipRect(x, top.toFloat(), x + width(), bottom.toFloat())
        val origin = x - scroll.x
        val border = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = if (row.header) look.tableHeaderBorderColor else look.borderColor
            strokeWidth = look.dp(1f)
            style = Paint.Style.STROKE
        }
        // The fill covers the header's columns, not the note's width: a narrow table's header ends with its last column.
        if (row.header) canvas.drawRect(origin, top.toFloat(), origin + columns * cellWidth, bottom.toFloat(), Paint().apply { color = look.codeBackground })
        for (column in 0 until columns) {
            val left = origin + column * cellWidth
            // Canvas clipping hides offscreen cells but still records their text drawing.
            // Include the border's half-stroke at either viewport edge.
            val edge = border.strokeWidth / 2
            if (left + cellWidth + edge < x || left - edge > x + width()) continue
            canvas.drawRect(left, top.toFloat(), left + cellWidth, bottom.toFloat(), border)
            val layout = built.layouts.getOrNull(column) ?: continue
            layout.paint.color = look.textColor
            val cellSave = canvas.save()
            // The cell's letters as seen centred, not its font box (which carried them low).
            canvas.translate(left + padding, top + (bottom - top - layout.height) / 2f - lettersBelowFontBoxCentre(layout.paint))
            val cell = row.cells[column]
            val shift = start - displayStart
            marks.drawCell(canvas, layout, cell.start + shift, cell.end + shift, look)
            layout.draw(canvas)
            canvas.restoreToCount(cellSave)
        }
        canvas.restoreToCount(save)
    }
    /** The caret offset in cell [column]'s text for a point [x],[y] in that cell's box (its padding included). */
    fun offsetIn(column: Int, x: Float, y: Float): Int {
        val layout = build().layouts.getOrNull(column) ?: return 0
        val line = layout.getLineForVertical((y - padding).toInt().coerceIn(0, layout.height))
        return layout.getOffsetForHorizontal(line, x - padding)
    }
    /** The link run under a point [x],[y] in cell [column]'s box: only the glyphs of the link itself, as a paragraph link. */
    fun linkAt(column: Int, x: Float, y: Float): CellRun? {
        val layout = build().layouts.getOrNull(column) ?: return null
        val cell = row.cells.getOrNull(column) ?: return null
        val lx = x - padding
        val ly = y - padding
        if (ly < 0 || ly >= layout.height) return null
        val line = layout.getLineForVertical(ly.toInt())
        if (lx < layout.getLineLeft(line) || lx > layout.getLineRight(line)) return null
        val lineRegion = Region(0, layout.getLineTop(line), layout.width + 1, layout.getLineBottom(line))
        val path = Path()
        for (run in cell.runs) {
            if (run.link == null && !(run.wiki && run.noteId != null)) continue
            val a = maxOf(run.start, layout.getLineStart(line)); val b = minOf(run.end, layout.getLineVisibleEnd(line))
            if (a >= b) continue
            path.reset()
            layout.getSelectionPath(a, b, path)
            val region = Region()
            region.setPath(path, lineRegion)
            if (region.contains(lx.toInt(), ly.toInt())) return run
        }
        return null
    }
    /** The column whose box holds [x] (relative to the row's left), or -1 outside the table. */
    fun columnAt(x: Float): Int = if (x < 0f || x >= width()) -1 else ((x + scroll.x) / cellWidth).toInt().takeIf { it in 0 until columns } ?: -1
    fun cellAt(x: Float): GridCell? = if (x < 0f || x >= width()) null
        else row.cells.getOrNull(((x + scroll.x) / cellWidth).toInt())
    /** Scroll the grid so the cell holding [offset] shows; true when it moved. */
    fun revealCell(offset: Int): Boolean {
        val column = row.cells.indexOfFirst { offset in it.start..it.end }
        return revealColumn(column)
    }
    fun revealColumn(column: Int): Boolean {
        if (column !in row.cells.indices) return false
        val cellWidth = cellWidth
        val left = column * cellWidth
        val visible = width().toFloat()
        val wanted = when {
            left < scroll.x -> left
            left + cellWidth > scroll.x + visible -> left + cellWidth - visible
            else -> return false
        }.coerceIn(0f, (columns * cellWidth - visible).coerceAtLeast(0f))
        if (wanted == scroll.x) return false
        scroll.x = wanted
        return true
    }
    fun scrollBy(dx: Float) { scroll.x = (scroll.x + dx).coerceIn(0f, (columns * cellWidth - width()).coerceAtLeast(0f)) }
}

/** A delimiter row while the person types it: its text as typed, muted (tables.md). */
internal class TfTypedDelimiter(private val look: TextFirstStyle) : CharacterStyle(), UpdateAppearance, TfSpan {
    override fun slice(head: Boolean): TfSpan = if (head) this else TfTypedDelimiter(look)
    override fun updateDrawState(paint: TextPaint) { paint.color = look.mutedColor }
}

/** The delimiter belongs to Markdown, and takes no visible row in the grid. */
internal class TfTableDelimiter(private val look: TextFirstStyle) : ReplacementSpan(), LineHeightSpan, TfAtom {
    override fun getSize(paint: Paint, text: CharSequence, start: Int, end: Int, fm: Paint.FontMetricsInt?) = 0
    override fun draw(canvas: Canvas, text: CharSequence, start: Int, end: Int, x: Float, top: Int, y: Int, bottom: Int, paint: Paint) {}
    /** No height at all once the TextView adds its line spacing: the header and body rows meet. */
    override fun chooseHeight(text: CharSequence, start: Int, end: Int, spanstartv: Int, lineHeight: Int, fm: Paint.FontMetricsInt) {
        fm.ascent = 0; fm.top = 0; fm.descent = -look.bodyLineSpacing; fm.bottom = fm.descent
    }
}

/** The styling of a cell's text, from the engine's runs (relative to the cell's own text, shifted by [shift]). */
internal fun styledCellText(look: TextFirstStyle, text: String, runs: List<CellRun>, shift: Int): android.text.SpannableStringBuilder {
    val out = android.text.SpannableStringBuilder(text)
    for (run in runs) {
        val a = (run.start + shift).coerceIn(0, text.length)
        val b = (run.end + shift).coerceIn(0, text.length)
        if (b <= a) continue
        if (run.bold || run.italic || run.strike || run.code) out.setSpan(TfInline(look, run.bold, run.italic, run.strike, run.code), a, b, TF_SPAN_FLAGS)
        if (run.link != null) out.setSpan(TfLink(look, run.link), a, b, TF_SPAN_FLAGS)
        else if (run.wiki) out.setSpan(CellWikiColor(look, run.noteId != null), a, b, TF_SPAN_FLAGS)
    }
    return out
}

/** A wikilink in a cell: the link colour when it resolves, muted when it does not. */
internal class CellWikiColor(private val look: TextFirstStyle, private val resolved: Boolean) : android.text.style.CharacterStyle(), TfSpan {
    override fun updateDrawState(tp: android.text.TextPaint) { tp.color = if (resolved) look.linkColor else look.mutedColor }
}
