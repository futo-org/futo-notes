package com.futo.notes.textfirst

import android.graphics.Canvas
import android.graphics.Paint
import android.text.Layout
import android.text.StaticLayout
import android.text.TextPaint
import android.text.style.LineHeightSpan
import android.text.style.ReplacementSpan
import uniffi.futo_notes_ffi.EditorTableAlignment

internal class TableScroll { var x = 0f }

/** One physical row, drawn from canonical cell descriptions. Width and scrolling are view concerns. */
internal class TfTableRow(
    private val look: TextFirstStyle,
    val row: GridRow,
    val displayStart: Int,
    val scroll: TableScroll,
    private val marks: FindMarks,
    private val width: () -> Int,
) : ReplacementSpan(), TfAtom {
    val cellWidth = look.dp(160f)
    private val padding = look.dp(10f)
    private val layouts = row.cells.map { cell ->
        val paint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
            textSize = look.textSizePx; color = look.textColor
            typeface = if (row.header) look.semibold else look.regular
        }
        StaticLayout.Builder.obtain(cell.text, 0, cell.text.length, paint, (cellWidth - padding * 2).toInt())
            .setAlignment(when (cell.alignment) {
                EditorTableAlignment.RIGHT -> Layout.Alignment.ALIGN_OPPOSITE
                EditorTableAlignment.CENTER -> Layout.Alignment.ALIGN_CENTER
                else -> Layout.Alignment.ALIGN_NORMAL
            }).setIncludePad(false).build()
    }
    private val rowHeight = maxOf(look.dp(48f).toInt(), (layouts.maxOfOrNull { it.height } ?: 0) + (padding * 2).toInt())
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
                old.text == cell.text && old.alignment == cell.alignment
        }
    }

    override fun getSize(paint: Paint, text: CharSequence, start: Int, end: Int, fm: Paint.FontMetricsInt?): Int {
        fm?.apply { ascent = -rowHeight; top = ascent; descent = 0; bottom = 0 }
        return width()
    }
    override fun draw(canvas: Canvas, text: CharSequence, start: Int, end: Int, x: Float, top: Int, y: Int, bottom: Int, paint: Paint) {
        val save = canvas.save()
        canvas.clipRect(x, top.toFloat(), x + width(), bottom.toFloat())
        val origin = x - scroll.x
        val border = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = look.borderColor; strokeWidth = look.dp(1f); style = Paint.Style.STROKE }
        if (row.header) canvas.drawRect(x, top.toFloat(), x + width(), bottom.toFloat(), Paint().apply { color = look.codeBackground })
        for (column in 0 until row.columns) {
            val left = origin + column * cellWidth
            // Canvas clipping hides offscreen cells but still records their text drawing.
            // Include the border's half-stroke at either viewport edge.
            val edge = border.strokeWidth / 2
            if (left + cellWidth + edge < x || left - edge > x + width()) continue
            canvas.drawRect(left, top.toFloat(), left + cellWidth, bottom.toFloat(), border)
            val layout = layouts.getOrNull(column) ?: continue
            layout.paint.color = look.textColor
            val cellSave = canvas.save()
            canvas.translate(left + padding, top + padding)
            val cell = row.cells[column]
            val shift = start - displayStart
            marks.drawCell(canvas, layout, cell.start + shift, cell.end + shift, look)
            layout.draw(canvas)
            canvas.restoreToCount(cellSave)
        }
        canvas.restoreToCount(save)
    }
    fun cellAt(x: Float): GridCell? = if (x < 0f || x >= width()) null
        else row.cells.getOrNull(((x + scroll.x) / cellWidth).toInt())
    /** Scroll the grid so the cell holding [offset] shows; true when it moved. */
    fun revealCell(offset: Int): Boolean {
        val column = row.cells.indexOfFirst { offset in it.start..it.end }
        return revealColumn(column)
    }
    fun revealColumn(column: Int): Boolean {
        if (column !in row.cells.indices) return false
        val left = column * cellWidth
        val visible = width().toFloat()
        val wanted = when {
            left < scroll.x -> left
            left + cellWidth > scroll.x + visible -> left + cellWidth - visible
            else -> return false
        }.coerceIn(0f, (row.columns * cellWidth - visible).coerceAtLeast(0f))
        if (wanted == scroll.x) return false
        scroll.x = wanted
        return true
    }
    fun scrollBy(dx: Float) { scroll.x = (scroll.x + dx).coerceIn(0f, (row.columns * cellWidth - width()).coerceAtLeast(0f)) }
}

/** The delimiter belongs to Markdown, and takes no visible row in the grid. */
internal class TfTableDelimiter : ReplacementSpan(), LineHeightSpan, TfAtom {
    override fun getSize(paint: Paint, text: CharSequence, start: Int, end: Int, fm: Paint.FontMetricsInt?) = 0
    override fun draw(canvas: Canvas, text: CharSequence, start: Int, end: Int, x: Float, top: Int, y: Int, bottom: Int, paint: Paint) {}
    override fun chooseHeight(text: CharSequence, start: Int, end: Int, spanstartv: Int, lineHeight: Int, fm: Paint.FontMetricsInt) {
        fm.ascent = -1; fm.top = -1; fm.descent = 0; fm.bottom = 0
    }
}
