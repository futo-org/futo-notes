package com.futo.notes.textfirst

import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF

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
    drawCodeHandles(canvas, firstLine, lastLine)
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
    l.draw(canvas)
    canvas.restoreToCount(save)
}

/** Whether the layout line is part of a code block. */
internal fun TextFirstEditText.isCodeLine(line: Int): Boolean {
    val l = layout ?: return false
    val e = editableText ?: return false
    val start = l.getLineStart(line)
    return start < e.length && e.getSpans(start, start + 1, TfCodeBlock::class.java)
        .any { e.getSpanStart(it) <= start && start < e.getSpanEnd(it) }
}

/** The touch target of the handle on the code block starting at [line], in layout coordinates (at least 40dp square). */
internal fun TextFirstEditText.codeHandleTarget(line: Int): RectF {
    val l = layout!!
    val half = style.dp(20f)
    val cx = l.width - style.dp(16f)
    val cy = l.getLineTop(line) + style.dp(16f)
    return RectF(cx - half, cy - half, cx + half, cy + half)
}

/** A muted corner handle on each code block's first line, which selects the block when tapped. */
private fun TextFirstEditText.drawCodeHandles(canvas: Canvas, firstLine: Int, lastLine: Int) {
    val look = style
    val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = look.mutedColor
        alpha = 150
        style = Paint.Style.STROKE
        strokeWidth = look.dp(1.5f)
    }
    val size = style.dp(7f)
    for (line in firstLine..lastLine) {
        if (!isCodeLine(line) || (line > 0 && isCodeLine(line - 1))) continue
        val t = codeHandleTarget(line)
        val cx = t.centerX()
        val cy = t.centerY()
        // A rounded square with a smaller one inside: "this whole block".
        canvas.drawRoundRect(cx - size, cy - size, cx + size, cy + size, style.dp(2.5f), style.dp(2.5f), paint)
        val inner = size * 0.4f
        canvas.drawRect(cx - inner, cy - inner, cx + inner, cy + inner, paint)
    }
}
