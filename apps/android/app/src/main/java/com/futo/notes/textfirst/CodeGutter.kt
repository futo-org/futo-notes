package com.futo.notes.textfirst

import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import android.text.Layout
import android.text.Selection
import android.text.Spanned

/**
 * A block's line numbers and their mark menu (!300 cb 81-109, 264-283). The numbers are drawn with
 * the card, not as text, and a number brightens on every line the selection is on: the caret's
 * line, or each line a range paints, an empty line only when the range runs through it. A tap on
 * a number opens the menu for that line without moving the caret; any other press closes it.
 * The menu's Highlight and Lowlight cannot act yet: the engine has no mark toggle.
 */
internal fun TextFirstEditText.drawCodeNumbers(canvas: Canvas, l: Layout, e: Spanned, lines: Array<TfCodeBlock>) {
    val look = style
    val paint = codeChrome.numberPaint(look)
    val start = Selection.getSelectionStart(e).let { s -> minOf(s, Selection.getSelectionEnd(e)) }
    val end = maxOf(Selection.getSelectionStart(e), Selection.getSelectionEnd(e))
    val selecting = start != end
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
        if (selecting) continue
        val top = l.getLineTop(line) + if (span.line.first) look.codeHeaderHeight else 0f
        val left = if (dir < 0) edge - span.ruleX else 0f
        val right = if (dir < 0) l.width.toFloat() else span.ruleX
        codeChrome.addNumber(RectF(left, top, right, l.getLineBottom(line).toFloat()), spanStart)
    }
}

/** The selection is on this code line: the caret in it, or a range that paints part of it. */
private fun isSelectionOnLine(start: Int, end: Int, lineStart: Int, lineEnd: Int, e: Spanned): Boolean {
    val textEnd = if (lineEnd > lineStart && e[lineEnd - 1] == '\n') lineEnd - 1 else lineEnd
    if (start == end) return start in lineStart..textEnd
    if (textEnd == lineStart) return start <= lineStart && end >= lineEnd
    return start < textEnd && end > lineStart
}

/** The open mark menu, over the line it is for, above the text. */
internal fun TextFirstEditText.drawCodeMarkMenu(canvas: Canvas) {
    val lineStart = codeChrome.markMenuLine
    if (lineStart < 0) return
    val l = layout ?: return
    val e = editableText ?: return
    if (lineStart >= e.length || e.getSpans(lineStart, lineStart, TfCodeBlock::class.java).none { e.getSpanStart(it) == lineStart }) {
        codeChrome.markMenuLine = -1
        return
    }
    val save = canvas.save()
    canvas.translate(totalPaddingLeft.toFloat(), totalPaddingTop.toFloat())
    val span = e.getSpans(lineStart, lineStart, TfCodeBlock::class.java).first { e.getSpanStart(it) == lineStart }
    val line = l.getLineForOffset(lineStart)
    val textTop = l.getLineTop(line) + if (span.line.first) style.codeHeaderHeight else 0f
    val left = l.getPrimaryHorizontal(lineStart) - style.codeChipPad
    val visibleTop = (scrollY - totalPaddingTop).toFloat()
    codeChrome.drawMarkMenu(canvas, MarkMenuPlace(lineStart, left, textTop, l.getLineBottom(line).toFloat(), visibleTop, span.line.mark))
    canvas.restoreToCount(save)
}
