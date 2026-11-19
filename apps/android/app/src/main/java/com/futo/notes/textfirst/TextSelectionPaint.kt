package com.futo.notes.textfirst

import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path

/**
 * The TextView fills every middle row of a selection from the note's left edge to its right, past a list's or quote's
 * hanging indent where no text is (Mason, S23). A selection over more than one visual row is painted here instead,
 * each row over its own text: the TextView's own path for a range inside one row, which starts where the row's text
 * starts, a right-to-left row's on the right. Code, table rows and objects keep their own painters; list markers are
 * drawListSelection's.
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
    if (!isTextSelectionPainted()) return
    val l = layout ?: return
    val text = editableText ?: return
    val start = minOf(selectionStart, selectionEnd)
    val end = maxOf(selectionStart, selectionEnd)
    val top = l.getLineForVertical(maxOf(0, scrollY - totalPaddingTop))
    val bottom = l.getLineForVertical(maxOf(0, scrollY - totalPaddingTop + height))
    val paint = Paint().apply { color = this@drawTextSelection.style.selectionColor }
    val row = Path()
    val save = canvas.save()
    canvas.translate(totalPaddingLeft.toFloat(), totalPaddingTop.toFloat())
    for (line in maxOf(l.getLineForOffset(start), top)..minOf(l.getLineForOffset(end), bottom)) {
        val lineStart = l.getLineStart(line)
        val from = maxOf(start, lineStart)
        val to = minOf(end, l.getLineVisibleEnd(line))
        if (from < to) {
            row.rewind()
            l.getSelectionPath(from, to, row)
            canvas.drawPath(row, paint)
            continue
        }
        // An empty row whose line break is selected shows a space's width at its start, as the TextView's highlight did.
        val lineEnd = l.getLineEnd(line)
        if (lineEnd == lineStart || end < lineEnd || text[lineEnd - 1] != '\n') continue
        val x = l.getPrimaryHorizontal(lineStart)
        val width = l.getParagraphDirection(line) * this.paint.measureText(" ")
        canvas.drawRect(minOf(x, x + width), l.getLineTop(line).toFloat(), maxOf(x, x + width), l.getLineBottom(line).toFloat(), paint)
    }
    canvas.restoreToCount(save)
}
