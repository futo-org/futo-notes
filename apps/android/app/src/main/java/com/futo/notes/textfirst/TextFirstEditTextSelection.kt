package com.futo.notes.textfirst

import android.graphics.Canvas
import android.graphics.Path
import android.graphics.RectF
import android.text.style.LeadingMarginSpan

/** Native selection fills middle rows; its first and last visual rows can omit list gutters. */
internal fun TextFirstEditText.drawListSelection(canvas: Canvas) {
    val start = minOf(selectionStart, selectionEnd)
    val end = maxOf(selectionStart, selectionEnd)
    if (start < 0 || start == end) return
    val l = layout ?: return
    val e = editableText ?: return
    val first = l.getLineForOffset(start)
    val last = l.getLineForOffset(end)
    val lines = if (first == last) intArrayOf(first) else intArrayOf(first, last)
    val save = canvas.save()
    canvas.translate(totalPaddingLeft.toFloat(), totalPaddingTop.toFloat())
    for (line in lines) {
        val top = l.getLineTop(line)
        var bottom = l.getLineBottom(line).toFloat()
        if (bottom < scrollY - totalPaddingTop || top > scrollY + height - totalPaddingTop) continue
        val at = l.getLineStart(line)
        val margins = e.getSpans(at, l.getLineEnd(line), LeadingMarginSpan::class.java)
        val dir = l.getParagraphDirection(line)
        var x = if (dir > 0) 0 else l.width
        for (margin in margins) {
            if (margin is TfList && margin.first && e.getSpanStart(margin) == at) {
                var bodyEnd = e.getSpanEnd(margin)
                if (bodyEnd == e.length && bodyEnd > at && e[bodyEnd - 1] == TextFirstEditText.END_SENTINEL[0]) bodyEnd--
                while (bodyEnd > at && (e[bodyEnd - 1] == '\n' || e[bodyEnd - 1] == '\r')) bodyEnd--
                if (start <= at && bodyEnd > at && end >= bodyEnd) {
                    if (line == last) {
                        // Match the final native highlight's exclusion of extra line spacing.
                        val path = Path().also { l.getSelectionPath(at, end, it) }
                        bottom = minOf(bottom, RectF().also { path.computeBounds(it, true) }.bottom)
                    }
                    margin.drawSelectedMargin(canvas, x, dir, top.toFloat(), bottom)
                }
            }
            x += dir * margin.getLeadingMargin(true)
        }
    }
    canvas.restoreToCount(save)
}
