package com.futo.notes.textfirst

import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF

/** Mason's desktop rule in its phone form: a selected image carries the selection colour over it, not only a band under it. */
internal fun TextFirstEditText.drawSelectedImageTint(canvas: Canvas) {
    val start = selectionStart
    val end = selectionEnd
    if (start >= end) return
    val l = layout ?: return
    val e = editableText ?: return
    val images = e.getSpans(start, end, TfImage::class.java).filter { e.getSpanStart(it) >= start && e.getSpanEnd(it) <= end }
    if (images.isEmpty()) return
    val tint = style.selectionColor
    val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = tint }
    val save = canvas.save()
    canvas.translate(totalPaddingLeft.toFloat(), totalPaddingTop.toFloat())
    for (image in images) {
        val at = e.getSpanStart(image)
        val (width, height) = image.drawSize()
        val x = l.getPrimaryHorizontal(at)
        val baseline = l.getLineBaseline(l.getLineForOffset(at)).toFloat()
        canvas.drawRoundRect(RectF(x, baseline - height, x + width, baseline), style.dp(6f), style.dp(6f), paint)
    }
    canvas.restoreToCount(save)
}

/** Whether [start] to [end] covers an image whole, so a change to or from it repaints the tint. */
internal fun TextFirstEditText.coversImage(start: Int, end: Int): Boolean {
    val e = editableText ?: return false
    if (start < 0 || start >= end || end > e.length) return false
    return e.getSpans(start, end, TfImage::class.java).any { e.getSpanStart(it) >= start && e.getSpanEnd(it) <= end }
}
