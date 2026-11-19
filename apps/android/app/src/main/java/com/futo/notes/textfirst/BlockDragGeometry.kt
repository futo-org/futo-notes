package com.futo.notes.textfirst

import android.graphics.Canvas
import android.graphics.RectF

// ---- view geometry, in content coordinates (the layout's plus the top padding) ----

/** The display offset under ([x], [y]) (view coordinates), as the engine reads a press; null off the text. */
internal fun TextFirstEditText.pressOffset(x: Float, y: Float): Int? {
    val l = layout ?: return null
    val e = editableText ?: return null
    val localY = y - totalPaddingTop + scrollY
    if (localY < 0 || localY >= l.height) return null
    // On a photo, the photo's start.
    imageAt(x, y)?.let { return e.getSpanStart(it) }
    val line = l.getLineForVertical(localY.toInt())
    val start = l.getLineStart(line)
    var rowEnd = minOf(l.getLineEnd(line), e.length - 1)
    if (rowEnd > start && e[rowEnd - 1] == '\n') rowEnd--
    if (rowEnd <= start) return start
    // The character nearest the finger on that row, whole: right of its last character, that character's start.
    var last = rowEnd - 1
    if (last > start && Character.isLowSurrogate(e[last]) && Character.isHighSurrogate(e[last - 1])) last--
    var at = l.getOffsetForHorizontal(line, x - totalPaddingLeft + scrollX).coerceIn(start, last)
    if (at > start && Character.isLowSurrogate(e[at]) && Character.isHighSurrogate(e[at - 1])) at--
    // Off a photo, a position inside one (beside it) steps past it: the finger is not on it.
    while (true) {
        val inside = e.getSpans(at, at, TfImage::class.java).firstOrNull { e.getSpanStart(it) <= at && at < e.getSpanEnd(it) } ?: break
        at = e.getSpanEnd(inside)
    }
    return at
}

/** The y of [slot]: the top of the line starting at its offset, or for the note's end the bottom of the last row; null past what the view holds. */
internal fun TextFirstEditText.boundaryY(slot: BlockSlot): Float? {
    val l = layout ?: return null
    if (slot.offset < 0 || slot.offset > length() - 1) return null
    val line = l.getLineForOffset(slot.offset)
    return totalPaddingTop + (if (slot.end) l.getLineBottom(line) else l.getLineTop(line)).toFloat()
}

/**
 * The photo [image] draws, in content coordinates: as tall as its bitmap above the row's
 * baseline, and in a right-to-left run to the left of its leading caret position.
 */
internal fun TextFirstEditText.imageRect(image: TfImage): RectF? {
    val l = layout ?: return null
    val e = editableText ?: return null
    val start = e.getSpanStart(image)
    if (start < 0) return null
    val line = l.getLineForOffset(start)
    val fm = android.graphics.Paint.FontMetricsInt()
    val width = image.getSize(paint, e, start, e.getSpanEnd(image), fm)
    val caret = totalPaddingLeft + l.getPrimaryHorizontal(start)
    val left = if (l.isRtlCharAt(start)) caret - width else caret
    val baseline = (totalPaddingTop + l.getLineBaseline(line)).toFloat()
    return RectF(left, baseline + fm.ascent, left + width, baseline)
}

/** The photo drawn under ([x], [y]) in view coordinates: inside its own box, not merely on its row. */
internal fun TextFirstEditText.imageAt(x: Float, y: Float): TfImage? {
    val l = layout ?: return null
    val e = editableText ?: return null
    val cx = x + scrollX
    val cy = y + scrollY
    val localY = cy - totalPaddingTop
    if (localY < 0 || localY >= l.height) return null
    val line = l.getLineForVertical(localY.toInt())
    for (image in e.getSpans(l.getLineStart(line), l.getLineEnd(line), TfImage::class.java)) {
        if (l.getLineForOffset(e.getSpanStart(image)) != line) continue
        if (imageRect(image)?.contains(cx, cy) == true) return image
    }
    return null
}

/** Draw the layout's text for display range [start, end) into [canvas] at content coordinates, as the view draws it. */
internal fun TextFirstEditText.drawLayoutRegion(canvas: Canvas, start: Int, end: Int) {
    val l = layout ?: return
    val e = editableText as? ChunkedEditable
    e?.drawWindow = start..end
    val save = canvas.save()
    try {
        canvas.translate(totalPaddingLeft.toFloat(), totalPaddingTop.toFloat())
        paint.color = currentTextColor
        l.draw(canvas)
    } finally {
        canvas.restoreToCount(save)
        e?.drawWindow = null
    }
}

/**
 * Draw the note laid out from content y [top] to [bottom], as the view draws it there: code
 * backgrounds, find marks, then the layout's lines (their line backgrounds, list markers, quote
 * bars, photos and tables). The reflow preview (BlockReflowPreview.kt) draws each slice with it
 * under its own clip and translation; unlike TextView.onDraw it is not clipped to where the view
 * is scrolled, so content laid out off screen can be drawn where the preview moves it.
 */
internal fun TextFirstEditText.drawNoteRegion(canvas: Canvas, top: Float, bottom: Float) {
    val l = layout ?: return
    if (bottom <= top) return
    val from = (top - totalPaddingTop).toInt()
    val to = kotlin.math.ceil(bottom - totalPaddingTop).toInt()
    val save = canvas.save()
    try {
        canvas.clipRect(0f, top, (width + scrollX).toFloat(), bottom)
        drawCodeBlocksForDrag(canvas, from, to)
        drawFindMarks(canvas, from, to)
        val e = editableText as? ChunkedEditable
        e?.drawWindow = l.getLineStart(l.getLineForVertical(maxOf(0, from)))..l.getLineEnd(l.getLineForVertical(maxOf(0, to)))
        try {
            canvas.translate(totalPaddingLeft.toFloat(), totalPaddingTop.toFloat())
            paint.color = currentTextColor
            l.draw(canvas)
        } finally {
            e?.drawWindow = null
        }
    } finally {
        canvas.restoreToCount(save)
    }
}

/** The note laid out from content y [from] to [to], drawn [shift] lower, where it shows between [top] and [bottom]. */
internal fun TextFirstEditText.drawSlice(canvas: Canvas, from: Float, to: Float, shift: Float, top: Float, bottom: Float) {
    val a = maxOf(from + shift, top)
    val b = minOf(to + shift, bottom)
    if (b <= a) return
    val save = canvas.save()
    canvas.clipRect(scrollX.toFloat(), a, (scrollX + width).toFloat(), b)
    canvas.translate(0f, shift)
    drawNoteRegion(canvas, a - shift, b - shift)
    canvas.restoreToCount(save)
}

private val coverPaint = android.graphics.Paint()

/** The page's colour from content y [from] to [to], where it shows between [top] and [bottom]: behind a part that may slide over its neighbours. */
internal fun TextFirstEditText.coverSlice(canvas: Canvas, from: Float, to: Float, top: Float, bottom: Float) {
    coverPaint.color = style.pageColor
    val a = maxOf(from, top)
    val b = minOf(to, bottom)
    if (b > a) canvas.drawRect(scrollX.toFloat(), a, (scrollX + width).toFloat(), b, coverPaint)
}

/** Put the line holding [hold]'s offset back with its top where it was on screen. */
internal fun TextFirstEditText.holdDropLine(hold: DropHold) {
    val l = layout ?: return
    val e = editableText ?: return
    val at = hold.offset.coerceIn(0, maxOf(0, e.length - 1))
    val start = e.lastIndexOf('\n', at - 1) + 1
    val y = totalPaddingTop + l.getLineTop(l.getLineForOffset(start))
    scrollTo(scrollX, (y - hold.top).coerceIn(0, maxScrollY()))
}
