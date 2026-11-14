package com.futo.notes.textfirst

import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path

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

/**
 * The text scrolled under the top padding. The TextView clips a scrolled view to
 * its padding box and offsets the text by the same padding, so unlike the bottom
 * (see `drawing`) the top padding cannot be zeroed for the clip alone: this draws
 * the layout once more, clipped to the padding band only.
 */
internal fun TextFirstEditText.drawTopPaddingBand(canvas: Canvas) {
    val l = layout ?: return
    if (scrollY <= 0 || totalPaddingTop <= 0) return
    val save = canvas.save()
    canvas.clipRect(0f, scrollY.toFloat(), width.toFloat() + scrollX, (scrollY + totalPaddingTop).toFloat())
    canvas.translate(totalPaddingLeft.toFloat(), totalPaddingTop.toFloat())
    // A whole-note selection can span thousands of lines; only build the path
    // for this band and one context line either side. Layout excludes extra
    // line spacing from a selection's first/last row, but includes it between
    // rows; the context keeps that native geometry inside the exposed band.
    val first = (l.getLineForVertical((scrollY - totalPaddingTop).coerceAtLeast(0)) - 1).coerceAtLeast(0)
    val last = (l.getLineForVertical(scrollY) + 1).coerceAtMost(l.lineCount - 1)
    val start = maxOf(minOf(selectionStart, selectionEnd), l.getLineStart(first))
    val end = minOf(maxOf(selectionStart, selectionEnd), l.getLineEnd(last))
    val selection = if (start >= 0 && end > start) Path().also { l.getSelectionPath(start, end, it) } else null
    val paint = Paint().apply { color = highlightColor }
    if (android.os.Build.VERSION.SDK_INT >= 34) {
        // On API36 the legacy overload passes null highlight lists and Layout
        // returns before drawing its selection. Empty lists keep that path live.
        l.draw(canvas, emptyList(), emptyList(), selection, paint, 0)
    } else {
        l.draw(canvas, selection, paint, 0)
    }
    canvas.restoreToCount(save)
}

/**
 * A hairline along the top edge while the note is scrolled. Text scrolls all the
 * way to this edge (see drawTopPaddingBand), which sits a few dp under the title
 * row; without an edge a heading cut there reads as drawn over the title.
 */
internal fun TextFirstEditText.drawScrollEdge(canvas: Canvas) {
    if (scrollY <= 0) return
    val paint = Paint().apply { color = this@drawScrollEdge.style.borderColor }
    val top = scrollY.toFloat()
    canvas.drawRect(scrollX.toFloat(), top, (scrollX + width).toFloat(), top + maxOf(1f, style.dp(1f)), paint)
}
