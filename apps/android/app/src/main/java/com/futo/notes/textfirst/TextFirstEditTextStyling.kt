package com.futo.notes.textfirst

import android.text.Editable
import android.text.Selection
import android.text.Spannable
import android.text.Spanned

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
            e.withRendererUpdate(update) {
                for (edit in update.edits) e.replace(edit.start, edit.end, edit.text)
                for (window in update.windows) restyle(e, window)
            }
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
            if (match >= 0) {
                setRendererSpan(e, span, s, en)
                wanted.removeAt(match)
                continue
            }
        }
        e.removeSpan(span)
        if (s < window.start) span.slice(head = true)?.let { setRendererSpan(e, it, s, window.start) }
        if (en > window.end) span.slice(head = false)?.let { setRendererSpan(e, it, window.end, en) }
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
        setRendererSpan(target, spans.create(spec), spec.start, end)
    }
}

private fun setRendererSpan(target: Spannable, span: TfSpan, start: Int, end: Int) {
    val block = span is TfHeading || span is TfQuote || span is TfList || span is TfCodeBlock || span is TfMetadata
    // Composition supplies raw text without new semantic windows. Keep the
    // existing block style on text inserted at its start or unfinished end.
    // A terminating newline belongs to this span, but the next line does not.
    val flags = when {
        !block -> TF_SPAN_FLAGS
        end >= target.length - 1 && (end == start || target[end - 1] != '\n') -> Spanned.SPAN_INCLUSIVE_INCLUSIVE
        else -> Spanned.SPAN_INCLUSIVE_EXCLUSIVE
    }
    if (target.getSpanStart(span) != start || target.getSpanEnd(span) != end || target.getSpanFlags(span) != flags) {
        target.setSpan(span, start, end, flags)
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
