package com.futo.notes.textfirst

import android.text.Editable

internal fun Editable.photoSpansToReuse(change: RendererChange?, windows: List<StyleWindow>): List<TfImage> {
    if (change == null || change.before == 0 || windows.none { window -> window.specs.any { it is SpanSpec.Image } }) {
        return emptyList()
    }
    return getSpans(change.start, change.start + change.before, TfImage::class.java).filter { it.bitmap != null }
}
