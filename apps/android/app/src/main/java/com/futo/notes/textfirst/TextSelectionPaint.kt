package com.futo.notes.textfirst

import android.graphics.Canvas
import android.graphics.Paint
import android.text.Layout
import android.text.Spanned

/**
 * The TextView fills every middle row of a selection from the note's left edge to its right, past a list's or quote's
 * hanging indent where no text is (Mason, S23). A selection over more than one visual row is painted here instead,
 * each row over its own text ([drawTextSelectionRow]). Code, table rows and objects keep their own painters, whose
 * prose rows use the same row; list markers are drawListSelection's.
 */
internal fun TextFirstEditText.isTextSelectionPainted(): Boolean {
    val start = minOf(selectionStart, selectionEnd)
    val end = maxOf(selectionStart, selectionEnd)
    if (start < 0 || start == end) return false
    if (selectedCodeBlock != null || codeSelectionTracker.painted != null || selectedObject != null) return false
    val l = layout ?: return false
    return l.getLineForOffset(start) != l.getLineForOffset(end) && selectedTableRows().isEmpty()
}

/** Under the text, as the TextView's highlight is. */
internal fun TextFirstEditText.drawTextSelection(canvas: Canvas) {
    // The rows a selection covers change with the width (a split screen): which painter shows it is decided here.
    refreshCodeHighlight()
    if (!isTextSelectionPainted()) return
    val l = layout ?: return
    val text = editableText ?: return
    val start = minOf(selectionStart, selectionEnd)
    val end = maxOf(selectionStart, selectionEnd)
    val top = l.getLineForVertical(maxOf(0, scrollY - totalPaddingTop))
    val bottom = l.getLineForVertical(maxOf(0, scrollY - totalPaddingTop + height))
    val paint = codeChrome.selectionPaint.apply { color = this@drawTextSelection.style.selectionColor }
    val save = canvas.save()
    canvas.translate(totalPaddingLeft.toFloat(), totalPaddingTop.toFloat())
    for (line in maxOf(l.getLineForOffset(start), top)..minOf(l.getLineForOffset(end), bottom)) {
        drawTextSelectionRow(canvas, l, text, line, start, end, paint)
    }
    canvas.restoreToCount(save)
}

/**
 * Visual row [line]'s part of the selection [start, end), over its text only: from where the selection enters the row
 * to where it leaves it or the row's text ends. A row of which only the line break is selected shows a space's width
 * where the selection starts, as the TextView's highlight did.
 */
internal fun TextFirstEditText.drawTextSelectionRow(canvas: Canvas, l: Layout, text: Spanned, line: Int, start: Int, end: Int, paint: Paint) {
    val lineStart = l.getLineStart(line)
    val lineEnd = l.getLineEnd(line)
    val from = maxOf(start, lineStart)
    val to = minOf(end, l.getLineVisibleEnd(line))
    val top = l.getLineTop(line).toFloat()
    val bottom = l.getLineBottom(line).toFloat()
    val rightToLeft = l.getParagraphDirection(line) < 0
    if (from < to) {
        // A row that ends where the next starts (a long word wrapped hard): a path to that offset would run past the
        // text to the edge and into the next row's indent.
        if (to == lineEnd && line + 1 < l.lineCount) {
            val x = l.getPrimaryHorizontal(from)
            if (rightToLeft) canvas.drawRect(l.getLineLeft(line), top, x, bottom, paint) else canvas.drawRect(x, top, l.getLineRight(line), bottom, paint)
            return
        }
        val row = codeChrome.selectionPath
        row.rewind()
        l.getSelectionPath(from, to, row)
        canvas.drawPath(row, paint)
        return
    }
    if (lineEnd == lineStart || end < lineEnd || from >= lineEnd || text[lineEnd - 1] != '\n') return
    val x = l.getPrimaryHorizontal(from)
    val width = (if (rightToLeft) -1 else 1) * this.paint.measureText(" ")
    canvas.drawRect(minOf(x, x + width), top, maxOf(x, x + width), bottom, paint)
}
