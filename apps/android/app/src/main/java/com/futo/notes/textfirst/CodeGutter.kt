package com.futo.notes.textfirst

import android.graphics.Canvas
import android.graphics.Paint
import android.text.Layout
import android.text.Selection
import android.text.Spanned

/**
 * A block's line numbers (!300 cb 264-283), drawn with the card, not as text, so a number brightens
 * on every line the selection is on without the text being redrawn: the caret's line, or each line
 * a range paints, an empty line only when the range runs through it.
 */
internal fun TextFirstEditText.drawCodeNumbers(canvas: Canvas, l: Layout, e: Spanned, lines: Array<TfCodeBlock>) {
    val look = style
    val paint = codeChrome.numberPaint(look)
    val start = Selection.getSelectionStart(e).let { s -> minOf(s, Selection.getSelectionEnd(e)) }
    val end = maxOf(Selection.getSelectionStart(e), Selection.getSelectionEnd(e))
    for (span in lines) {
        val spanStart = e.getSpanStart(span)
        val spanEnd = e.getSpanEnd(span)
        val line = l.getLineForOffset(spanStart)
        val dir = l.getParagraphDirection(line)
        val edge = if (dir < 0) l.getParagraphRight(line).toFloat() else 0f
        val on = isFocused && start >= 0 && isSelectionOnLine(start, end, spanStart, spanEnd, e)
        paint.color = if (on) look.codeNumberActiveColor else look.codeNumberColor
        paint.textAlign = if (dir < 0) Paint.Align.LEFT else Paint.Align.RIGHT
        canvas.drawText(span.line.number.toString(), edge + span.numberEnd * dir, l.getLineBaseline(line).toFloat(), paint)
    }
}

/** The selection is on this code line: the caret in it, or a range that paints part of it. */
private fun isSelectionOnLine(start: Int, end: Int, lineStart: Int, lineEnd: Int, e: Spanned): Boolean {
    val textEnd = if (lineEnd > lineStart && e[lineEnd - 1] == '\n') lineEnd - 1 else lineEnd
    if (start == end) return start in lineStart..textEnd
    if (textEnd == lineStart) return start <= lineStart && end >= lineEnd
    return start < textEnd && end > lineStart
}
