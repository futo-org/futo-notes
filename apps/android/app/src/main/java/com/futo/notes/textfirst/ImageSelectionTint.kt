package com.futo.notes.textfirst

import android.graphics.Canvas

/** Mason's desktop rule in its phone form: a selected image carries the selection colour over it, not only a band under it. */
internal fun TextFirstEditText.drawSelectedImageTint(canvas: Canvas) {
    if (selectionStart >= selectionEnd) return
    val l = layout ?: return
    val e = editableText ?: return
    // Only the lines on screen: a whole-note selection is not scanned on every caret blink.
    val top = scrollY - totalPaddingTop
    val start = maxOf(selectionStart, l.getLineStart(l.getLineForVertical(maxOf(0, top))))
    val end = minOf(selectionEnd, l.getLineEnd(l.getLineForVertical(maxOf(0, top + height))))
    if (start >= end) return
    val images = e.getSpans(start, end, TfImage::class.java)
    if (images.isEmpty()) return
    val tint = style.selectionColor
    val paint = codeChrome.selectionPaint.apply { color = tint }
    val rect = codeChrome.selectionRow
    val save = canvas.save()
    canvas.translate(totalPaddingLeft.toFloat(), totalPaddingTop.toFloat())
    for (image in images) {
        val at = e.getSpanStart(image)
        if (at < selectionStart || e.getSpanEnd(image) > selectionEnd) continue
        if (imageDrawnRect(l, e, image, rect)) canvas.drawRoundRect(rect, style.dp(6f), style.dp(6f), paint)
    }
    canvas.restoreToCount(save)
}

/** Whether [start] to [end] covers an image whole, so a change to or from it repaints the tint. */
internal fun TextFirstEditText.coversImage(start: Int, end: Int): Boolean {
    val e = editableText ?: return false
    if (start < 0 || start >= end || end > e.length) return false
    return e.getSpans(start, end, TfImage::class.java).any { e.getSpanStart(it) >= start && e.getSpanEnd(it) <= end }
}

/**
 * The image [start] to [end] selects exactly, as one object (a tap, Backspace after it, a long-press): the keyboard's
 * collapse-and-delete then removes it whole, and the TextView's own highlight stays hidden under its tint.
 */
internal fun TextFirstEditText.imageSelectedWhole(start: Int, end: Int): Pair<Int, Int>? {
    val e = editableText ?: return null
    if (start < 0 || start >= end || end > e.length) return null
    return e.getSpans(start, end, TfImage::class.java).firstOrNull { e.getSpanStart(it) == start && e.getSpanEnd(it) == end }?.let { start to end }
}

/**
 * Where [image] is drawn, layout coordinates, into [out]: its row's baseline is its bottom and its start its leading
 * side (the right one in a right-to-left row). False when it is no longer in the text.
 */
internal fun imageDrawnRect(l: android.text.Layout, e: android.text.Spanned, image: TfImage, out: android.graphics.RectF): Boolean {
    val start = e.getSpanStart(image)
    if (start < 0) return false
    val (width, height) = image.drawSize()
    val x = l.getPrimaryHorizontal(start)
    val left = if (l.isRtlCharAt(start)) x - width else x
    val bottom = l.getLineBaseline(l.getLineForOffset(start)).toFloat()
    out.set(left, bottom - height, left + width, bottom)
    return true
}
