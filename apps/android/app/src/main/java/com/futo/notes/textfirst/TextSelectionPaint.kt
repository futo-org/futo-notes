package com.futo.notes.textfirst

import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.text.Layout
import android.text.Spanned

/**
 * The TextView fills every middle row of a selection from the note's left edge to its right, past a list's or quote's
 * hanging indent where no text is (Mason, S23), and on its text box, high on the letters. A text selection is painted
 * here instead, each row over its own text on its [overlayBand] ([drawTextSelectionRow]). Code, table rows and objects
 * keep their own painters, whose prose rows use the same row; list markers are drawListSelection's.
 */
internal fun TextFirstEditText.isTextSelectionPainted(): Boolean {
    val start = minOf(selectionStart, selectionEnd)
    val end = maxOf(selectionStart, selectionEnd)
    if (start < 0 || start == end) return false
    if (selectedCodeBlock != null || codeSelectionTracker.painted != null || selectedObject != null) return false
    return selectedTableRows().isEmpty()
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
 * selected ([selectedPartOfRow]), one shape with it, on the row's [overlayBand].
 */
internal fun TextFirstEditText.drawTextSelectionRow(canvas: Canvas, l: Layout, text: Spanned, line: Int, start: Int, end: Int, paint: Paint) {
    val path = codeChrome.selectionPath
    if (selectionRowShape(l, text, line, start, end, path)) canvas.drawPath(path, paint)
}

/** Row [line]'s part of [start, end) as [drawTextSelectionRow] draws it, into [out] (rewound first); false with none. */
internal fun TextFirstEditText.selectionRowShape(l: Layout, text: Spanned, line: Int, start: Int, end: Int, out: Path): Boolean {
    out.rewind()
    val lineStart = l.getLineStart(line)
    val lineEnd = l.getLineEnd(line)
    val row = TextRow(lineStart, lineEnd, l.getLineVisibleEnd(line), lineEnd > lineStart && text[lineEnd - 1] == '\n')
    val part = selectedPartOfRow(row, start, end) ?: return false
    val (top, bottom) = overlayBand(l, text, line)
    val rightToLeft = l.getParagraphDirection(line) < 0
    val breakEdges = part.breakAt?.let { lineBreakTintEdges(l.getPrimaryHorizontal(it), this.paint.measureText(" "), rightToLeft) }
    if (part.from == part.to) {
        if (breakEdges == null) return false
        out.addRect(breakEdges.first, top, breakEdges.second, bottom, Path.Direction.CW)
        return true
    }
    // A row that ends where the next starts (a long word wrapped hard): a path to that offset would run past the
    // text to the edge and into the next row's indent.
    if (part.to == lineEnd && line + 1 < l.lineCount) {
        val x = l.getPrimaryHorizontal(part.from)
        if (rightToLeft) out.addRect(l.getLineLeft(line), top, x, bottom, Path.Direction.CW) else out.addRect(x, top, l.getLineRight(line), bottom, Path.Direction.CW)
        return true
    }
    l.getSelectionPath(part.from, part.to, out)
    fitToOverlayBand(l, text, line, out)
    if (breakEdges != null) {
        // Joined into the text's own outline: two shapes side by side would show a seam where they meet.
        val stub = codeChrome.selectionBreak
        stub.rewind()
        stub.addRect(breakEdges.first, top, breakEdges.second, bottom, Path.Direction.CW)
        out.op(stub, Path.Op.UNION)
    }
    return true
}
