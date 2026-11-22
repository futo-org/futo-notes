package com.futo.notes.textfirst

import android.graphics.Canvas

/** The front matter's card, under the selection's tint and the text. Front matter only ever opens a note. */
internal fun TextFirstEditText.drawMetadataCard(canvas: Canvas) {
    val l = layout ?: return
    val e = editableText ?: return
    val card = e.getSpans(0, minOf(1, e.length), TfMetadata::class.java).firstOrNull() ?: return
    val start = e.getSpanStart(card)
    val end = e.getSpanEnd(card)
    if (start < 0 || end <= start) return
    val top = l.getLineTop(l.getLineForOffset(start)).toFloat()
    val bottom = l.getLineBottom(l.getLineForOffset(end - 1)).toFloat()
    val save = canvas.save()
    canvas.translate(totalPaddingLeft.toFloat(), totalPaddingTop.toFloat())
    card.drawCard(canvas, l.width.toFloat(), top, bottom)
    canvas.restoreToCount(save)
}
