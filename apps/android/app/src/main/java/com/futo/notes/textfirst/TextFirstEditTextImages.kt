package com.futo.notes.textfirst

import android.text.Editable

internal fun Editable.photoSpansToReuse(change: RendererChange?, windows: List<StyleWindow>): List<TfImage> {
    if (change == null || change.before == 0 || windows.none { window -> window.specs.any { it is SpanSpec.Image } }) {
        return emptyList()
    }
    return getSpans(change.start, change.start + change.before, TfImage::class.java).filter { it.bitmap != null }
}

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
            val wasApplying = applying
            applying = true
            try { current.setSpan(span, s, en, TF_SPAN_FLAGS) } finally { applying = wasApplying }
            requestLayout()
            invalidate()
        }
    }
}
