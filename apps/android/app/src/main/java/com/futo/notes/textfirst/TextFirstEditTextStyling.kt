package com.futo.notes.textfirst

import android.text.Editable
import android.text.Selection
import android.text.Spannable

// Putting the engine's spans and appended text onto the view's Editable.

/** The next part of a progressively opened note, after what shows now. */
internal fun TextFirstEditText.applyAppend(update: UiUpdate) {
    val e = editableText ?: return
    applying = true
    try {
        val start = Selection.getSelectionStart(e)
        val end = Selection.getSelectionEnd(e)
        beginBatchEdit()
        try {
            for (edit in update.edits) e.replace(edit.start, edit.end, edit.text)
            for (window in update.windows) restyle(e, window)
        } finally {
            endBatchEdit()
        }
        // A caret at the end of what showed would be pushed past the new text.
        if (Selection.getSelectionStart(e) != start || Selection.getSelectionEnd(e) != end) Selection.setSelection(e, start, end)
    } finally {
        applying = false
    }
}

/** Replace the renderer's spans inside a window, keeping identical ones so the layout does not reflow them. */
internal fun TextFirstEditText.restyle(e: Editable, given: StyleWindow) {
    // A window reaching the display's end also owns the end sentinel.
    val window = if (given.end == e.length - 1) StyleWindow(given.start, given.end + 1, given.specs) else given
    val wanted = window.specs.toMutableList()
    for (span in e.getSpans(window.start, window.end, TfSpan::class.java)) {
        val s = e.getSpanStart(span)
        val en = e.getSpanEnd(span)
        if (s < 0) continue
        // A neighbour that only touches the window is not part of it.
        if (s != en && (en <= window.start || s >= window.end) && window.start != window.end) continue
        if (s >= window.start && en <= window.end) {
            val match = wanted.indexOfFirst { (it.start == s && (it.end == en || it.start == it.end && en == s + 1)) && spans.matches(it, span) }
            if (match >= 0) { wanted.removeAt(match); continue }
        }
        e.removeSpan(span)
        if (s < window.start) span.slice(head = true)?.let { e.setSpan(it, s, window.start, TF_SPAN_FLAGS) }
        if (en > window.end) span.slice(head = false)?.let { e.setSpan(it, window.end, en, TF_SPAN_FLAGS) }
    }
    addSpans(e, wanted)
    if (wanted.any { it is SpanSpec.Image }) requestImageLoads(window.start, window.end)
}

internal fun TextFirstEditText.addSpans(target: Spannable, specs: List<SpanSpec>) {
    for (spec in specs) {
        if (spec.end < spec.start || spec.end > target.length - 1) continue
        // A block on the empty last line (a new list item at the end) sits
        // on the end sentinel; Android lays out no paragraph spans for an
        // empty last line.
        val end = if (spec.start == spec.end && spec.start == target.length - 1) spec.end + 1 else spec.end
        target.setSpan(spans.create(spec), spec.start, end, TF_SPAN_FLAGS)
    }
}

internal fun TextFirstEditText.requestImageLoads(from: Int = 0, to: Int = Int.MAX_VALUE) {
    val e = editableText ?: return
    for (span in e.getSpans(from, minOf(to, e.length), TfImage::class.java)) {
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
