package com.futo.notes.textfirst

import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
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
 * to where it leaves it or the row's text ends, and a space's width after the text when the row's line break is
 * selected ([selectedPartOfRow]), one shape with it.
 */
internal fun TextFirstEditText.drawTextSelectionRow(canvas: Canvas, l: Layout, text: Spanned, line: Int, start: Int, end: Int, paint: Paint) {
    val lineStart = l.getLineStart(line)
    val lineEnd = l.getLineEnd(line)
    val row = TextRow(lineStart, lineEnd, l.getLineVisibleEnd(line), lineEnd > lineStart && text[lineEnd - 1] == '\n')
    val part = selectedPartOfRow(row, start, end) ?: return
    val top = l.getLineTop(line).toFloat()
    val bottom = l.getLineBottom(line).toFloat()
    val rightToLeft = l.getParagraphDirection(line) < 0
    val breakEdges = part.breakAt?.let { lineBreakTintEdges(l.getPrimaryHorizontal(it), this.paint.measureText(" "), rightToLeft) }
    if (part.from == part.to) {
        if (breakEdges != null) canvas.drawRect(breakEdges.first, top, breakEdges.second, bottom, paint)
        return
    }
    // A row that ends where the next starts (a long word wrapped hard): a path to that offset would run past the
    // text to the edge and into the next row's indent.
    if (part.to == lineEnd && line + 1 < l.lineCount) {
        val x = l.getPrimaryHorizontal(part.from)
        if (rightToLeft) canvas.drawRect(l.getLineLeft(line), top, x, bottom, paint) else canvas.drawRect(x, top, l.getLineRight(line), bottom, paint)
        return
    }
    val path = codeChrome.selectionPath
    path.rewind()
    l.getSelectionPath(part.from, part.to, path)
    if (breakEdges != null) {
        // Joined into the text's own outline: two shapes side by side would show a seam where they meet.
        val bounds = codeChrome.selectionRow
        path.computeBounds(bounds, true)
        path.op(Path().apply { addRect(breakEdges.first, bounds.top, breakEdges.second, bounds.bottom, Path.Direction.CW) }, Path.Op.UNION)
    }
    canvas.drawPath(path, paint)
}
