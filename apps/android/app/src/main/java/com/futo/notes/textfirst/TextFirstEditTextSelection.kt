package com.futo.notes.textfirst

import android.graphics.Canvas
import android.text.style.LeadingMarginSpan

/** A list row the selection covers whole has its marker gutter tinted too (lists.md); the rows' text is TextSelectionPaint's. */
internal fun TextFirstEditText.drawListSelection(canvas: Canvas) {
    val start = minOf(selectionStart, selectionEnd)
    val end = maxOf(selectionStart, selectionEnd)
    if (start < 0 || start == end) return
    val l = layout ?: return
    val e = editableText ?: return
    val first = l.getLineForOffset(start)
    val last = l.getLineForOffset(end)
    // Only the rows on screen: a whole-note selection is not walked on every frame.
    val shownFirst = maxOf(first, l.getLineForVertical(maxOf(0, scrollY - totalPaddingTop)))
    val shownLast = minOf(last, l.getLineForVertical(maxOf(0, scrollY - totalPaddingTop + height)))
    val save = canvas.save()
    canvas.translate(totalPaddingLeft.toFloat(), totalPaddingTop.toFloat())
    for (line in shownFirst..shownLast) {
        val (top, bottom) = overlayBand(l, e, line)
        val at = l.getLineStart(line)
        val margins = e.getSpans(at, l.getLineEnd(line), LeadingMarginSpan::class.java)
        val dir = l.getParagraphDirection(line)
        var x = if (dir > 0) 0 else l.width
        for (margin in margins) {
            if (margin is TfList && margin.first && e.getSpanStart(margin) == at) {
                var rowEnd = e.getSpanEnd(margin)
                if (rowEnd == e.length && rowEnd > at && e[rowEnd - 1] == TextFirstEditText.END_SENTINEL[0]) rowEnd--
                var bodyEnd = rowEnd
                while (bodyEnd > at && (e[bodyEnd - 1] == '\n' || e[bodyEnd - 1] == '\r')) bodyEnd--
                // An empty row has selectable content only in its real newline.
                val selectedEnd = if (bodyEnd > at) bodyEnd
                    else if (rowEnd > at && e[rowEnd - 1] == '\n') rowEnd else at
                if (start <= at && selectedEnd > at && end >= selectedEnd) {
                    margin.drawSelectedMargin(canvas, x, dir, top, bottom)
                }
            }
            x += dir * margin.getLeadingMargin(true)
        }
    }
    canvas.restoreToCount(save)
}
