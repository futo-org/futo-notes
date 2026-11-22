package com.futo.notes.textfirst

import android.graphics.Canvas

/** The front matter's card, under the selection's tint and the text. Front matter only ever opens a note. */
internal fun TextFirstEditText.drawMetadataCard(canvas: Canvas) {
    val l = layout ?: return
    val e = editableText ?: return
    val card = e.getSpans(0, minOf(1, e.length), TfMetadata::class.java).firstOrNull() ?: return
    val start = e.getSpanStart(card)
    if (start < 0) return
    // The engine gives each front-matter row its own span: the card runs through every one that follows on.
    var end = e.getSpanEnd(card)
    while (end < e.length) {
        val next = e.getSpans(end, end + 1, TfMetadata::class.java).maxOfOrNull { if (e.getSpanStart(it) == end) e.getSpanEnd(it) else -1 } ?: -1
        if (next <= end) break
        end = next
    }
    if (end <= start) return
    val top = l.getLineTop(l.getLineForOffset(start)).toFloat()
    val bottom = l.getLineBottom(l.getLineForOffset(end - 1)).toFloat()
    val save = canvas.save()
    canvas.translate(totalPaddingLeft.toFloat(), totalPaddingTop.toFloat())
    card.drawCard(canvas, l.width.toFloat(), top, bottom)
    canvas.restoreToCount(save)
}
