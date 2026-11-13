package com.futo.notes.textfirst

import android.text.Editable
import android.text.Selection
import android.text.Spannable
import android.text.Spanned

// Putting the engine's spans and appended text onto the view's Editable.

/** The next part of a progressively opened note, after what shows now. */
internal fun TextFirstEditText.applyAppend(update: UiUpdate) {
    val e = editableText ?: return
    val observer = onApplyMeasured
    val applyStart = if (observer != null) android.os.SystemClock.elapsedRealtimeNanos() else 0L
    var editsEnd = applyStart
    applying = true
    try {
        val start = Selection.getSelectionStart(e)
        val end = Selection.getSelectionEnd(e)
        val oldLast = (e.length - 1).coerceAtLeast(0)
        val followsLogicalSelection = start == update.selStart.coerceIn(0, oldLast) && end == update.selEnd.coerceIn(0, oldLast)
        // A selection past the view's end rides along with the arriving text
        // (it sits at the insertion point): the reader did not move it, so the
        // view does not scroll to it.
        val clipped = followsLogicalSelection && maxOf(update.selStart, update.selEnd) > oldLast
        reveal.quiet = clipped
        beginBatchEdit()
        try {
            e.withRendererUpdate(this, update) {
                for (edit in update.edits) e.replace(edit.start, edit.end, edit.text)
                if (observer != null) editsEnd = android.os.SystemClock.elapsedRealtimeNanos()
                for (window in update.windows) restyle(e, window)
            }
        } finally {
            endBatchEdit()
        }
        // Extend a still-clipped logical selection as its text arrives. A
        // newer native touch range must survive an already-posted append.
        val last = (e.length - 1).coerceAtLeast(0)
        val a = if (followsLogicalSelection) update.selStart.coerceIn(0, last) else start
        val b = if (followsLogicalSelection) update.selEnd.coerceIn(0, last) else end
        if (Selection.getSelectionStart(e) != a || Selection.getSelectionEnd(e) != b) Selection.setSelection(e, a, b)
        if (clipped) reveal.hold(b, a)
    } finally {
        reveal.quiet = false
        applying = false
    }
    observer?.invoke(KeyTimings(
        update.inputUptimeNanos, update.postedNanos, update.engineNanos,
        applyStart, editsEnd, android.os.SystemClock.elapsedRealtimeNanos(),
    ), update)
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

/**
 * Draw marked (composing) text in the inline formats the engine says it will
 * commit with. Only inline spans change: block spans already cover it.
 */
internal fun TextFirstEditText.restyleMarked(e: Editable, start: Int, composingEnd: Int, marked: List<SpanSpec.Inline>) {
    val end = minOf(composingEnd, e.length - 1)
    if (start < 0 || end <= start) return
    for (span in e.getSpans(start, end, TfInline::class.java)) {
        val s = e.getSpanStart(span)
        val en = e.getSpanEnd(span)
        if (s < 0 || (s != en && (en <= start || s >= end))) continue
        e.removeSpan(span)
        if (s < start) span.slice(head = true)?.let { setRendererSpan(e, it, s, start) }
        if (en > end) span.slice(head = false)?.let { setRendererSpan(e, it, end, en) }
    }
    addSpans(e, marked)
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
    val block = span is TfHeading || span is TfQuote || span is TfList || span is TfIndent || span is TfCodeBlock || span is TfMetadata
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

/** Restyle an acknowledged bounded window without replacing a newer native selection or composition. */
internal fun TextFirstEditText.applyStyleSlice(update: UiUpdate) {
    val began = android.os.SystemClock.elapsedRealtimeNanos()
    // The attached DynamicLayout reflows synchronously with the coherent
    // renderer notification. Correct that change once; the open-note image
    // pin would keep overriding later keyboard navigation and caret reveal.
    val anchor = if (restoring == null) scrollAnchor() else null
    val start = selectionStart
    val end = selectionEnd
    applying = true
    try {
        beginBatchEdit()
        try { editableText.withRendererUpdate(this, update) { for (window in update.windows) restyle(editableText, window) } }
        finally { endBatchEdit() }
        // TextView's renderer watcher may normalize a reverse range. This
        // slice has no selection authority over newer keyboard/touch input.
        if (start >= 0 && end >= 0) Selection.setSelection(editableText, start, end)
    } finally { applying = false }
    anchor?.let { anchorY(it)?.let { y -> if (y != scrollY) scrollTo(scrollX, y) } }
    onApplyMeasured?.invoke(KeyTimings(0L, update.postedNanos, 0L, began, began, android.os.SystemClock.elapsedRealtimeNanos()), update)
}
