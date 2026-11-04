package com.futo.notes.textfirst

import android.graphics.Canvas
import android.graphics.Paint

/**
 * Each visible code line's background, full width. The view paints it, ahead of
 * the TextView's own drawing, because the TextView draws the caret before the
 * layout's line backgrounds: a LineBackgroundSpan would cover the caret.
 */
internal fun TextFirstEditText.drawCodeBackgrounds(canvas: Canvas) {
    val l = layout ?: return
    val e = editableText ?: return
    val top = scrollY - totalPaddingTop
    val firstLine = l.getLineForVertical(maxOf(0, top))
    val lastLine = l.getLineForVertical(maxOf(0, top + height))
    val blocks = e.getSpans(l.getLineStart(firstLine), l.getLineEnd(lastLine), TfCodeBlock::class.java)
    if (blocks.isEmpty()) return
    val paint = Paint().apply { color = this@drawCodeBackgrounds.style.surfaceColor }
    val save = canvas.save()
    canvas.translate(totalPaddingLeft.toFloat(), totalPaddingTop.toFloat())
    for (block in blocks) {
        val s = e.getSpanStart(block)
        val en = e.getSpanEnd(block)
        // The lines the span overlaps, as Layout.drawBackground counts them.
        val from = maxOf(firstLine, l.getLineForOffset(s))
        val to = minOf(lastLine, l.getLineForOffset(if (en > s) en - 1 else s))
        for (line in from..to) {
            canvas.drawRect(0f, l.getLineTop(line).toFloat(), l.width.toFloat(), l.getLineBottom(line).toFloat(), paint)
        }
    }
    canvas.restoreToCount(save)
}
