package com.futo.notes.textfirst

/** Starts loading every image on the note that has no bitmap yet; each one re-lays out its line when it lands. */
internal fun TextFirstEditText.requestImageLoads() {
    val e = editableText ?: return
    for (span in e.getSpans(0, e.length, TfImage::class.java)) {
        if (span.bitmap != null || span.failed) continue
        images.load(span.destination, span.vault, span.remote, contentWidth()) { bitmap ->
            val current = editableText
            val s = current.getSpanStart(span)
            if (s < 0) return@load
            if (bitmap == null) span.failed = true else span.bitmap = bitmap
            val en = current.getSpanEnd(span)
            applying = true
            try { current.setSpan(span, s, en, TF_SPAN_FLAGS) } finally { applying = false }
            requestLayout()
            invalidate()
        }
    }
}
