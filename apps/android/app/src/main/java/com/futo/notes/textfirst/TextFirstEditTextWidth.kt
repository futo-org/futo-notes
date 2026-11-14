package com.futo.notes.textfirst

import android.text.NoCopySpan
import android.text.Selection
import android.text.SpannableStringBuilder
import android.widget.TextView.BufferType

// A new width (rotation, split screen, a fold, a resized window) or text locale
// makes TextView build a new layout over every character it holds,
// synchronously, inside measure. Over a fully streamed note of megabytes that is
// seconds on the main thread: an ANR on rotation. So before such a relayout a
// long view keeps only a bounded prefix and the engine streams the rest again,
// in the same acknowledged slices as an open. The engine never stops holding
// the whole note, its edits or its selection; only the view's rendering is redone.

internal object WidthChange {
    /** The most text a relayout lays out at once: about two of the stream's slices. */
    const val MAX_RELAYOUT_CHARS = 16_000
}

/** Called from onMeasure with the text width about to be laid out. */
internal fun TextFirstEditText.beforeNewWidth(width: Int) {
    val l = layout ?: return
    if (width <= 0 || width == l.width) return
    if (boundForRelayout()) return
    // Re-wrapped lines move under a fixed scroll offset; keep the reader's line at the top instead.
    val anchor = scrollAnchor()
    stopPinning()
    if (anchor != null && scrollY > 0) { restoring = anchor; scheduleRestore() }
}

/**
 * Before TextView lays out every line again: cut a long view to a bounded
 * prefix and have the engine stream the rest. False when the view is short
 * enough to lay out whole (or has no engine to stream from).
 */
internal fun TextFirstEditText.boundForRelayout(): Boolean {
    val e = editableText as? ChunkedEditable ?: return false
    val engine = engine ?: return false
    if (layout == null || e.length <= WidthChange.MAX_RELAYOUT_CHARS) return false
    val anchor = scrollAnchor()
    stopPinning() // an earlier restore's line, at the old layout; the restore below pins the new one
    // The reader's line comes back at once when it is near the top; past that
    // it returns when the stream reaches it (applyRestore waits for it).
    val through = anchor?.offset?.takeIf { it + OpenSlices.FIRST_CHARS <= WidthChange.MAX_RELAYOUT_CHARS } ?: 0
    val keep = lineEndAfter(e, OpenSlices.FIRST_CHARS + through, WidthChange.MAX_RELAYOUT_CHARS)
    val selStart = selectionStart
    val selEnd = selectionEnd
    restoring = anchor
    contentComplete = false
    awaitingRelayout = true
    applying = true
    try {
        setText(e.prefix(keep, TextFirstEditText.END_SENTINEL), BufferType.EDITABLE)
        Selection.setSelection(editableText, selStart.coerceIn(0, keep), selEnd.coerceIn(0, keep))
    } finally {
        applying = false
    }
    // Until the reader's line is laid out again the prefix shows from its top, never blank space past its end.
    scrollTo(scrollX, 0)
    scheduleRestore()
    engine.relayoutView(through)
    return true
}

/**
 * The first [end] characters with the spans in them (cut at [end]), then
 * [suffix]. Unlike [ChunkedEditable.subSequence] it keeps the renderer's
 * styling: it is the view itself, cut short, not a copy for someone else.
 */
private fun ChunkedEditable.prefix(end: Int, suffix: String): ChunkedEditable {
    val chars = CharArray(end)
    getChars(0, end, chars, 0)
    val out = SpannableStringBuilder(String(chars) + suffix)
    for (span in getSpans(0, end, Any::class.java)) {
        if (span is NoCopySpan) continue // the view's and layout's watchers, the selection
        val s = getSpanStart(span)
        if (s >= end) continue
        out.setSpan(span, s, minOf(getSpanEnd(span), end), getSpanFlags(span))
    }
    return ChunkedEditable.from(out)
}

/** Just past the first line end at or after [target], within [limit] and the text's end sentinel. */
private fun lineEndAfter(e: CharSequence, target: Int, limit: Int): Int {
    val last = e.length - 1
    var i = minOf(target, last)
    while (i < last && i < limit) {
        if (e[i] == '\n') return i + 1
        i++
    }
    // Never between the halves of a surrogate pair.
    return if (i in 1 until last && e[i - 1].isHighSurrogate() && e[i].isLowSurrogate()) i - 1 else i
}

/** Refresh width-sensitive spans after layout; the height-only path stays untouched. */
internal fun TextFirstEditText.refreshWidthDependentSpans() {
    val e = editableText ?: return
    applying = true
    try {
        for (atom in e.getSpans(0, e.length, TfAtom::class.java)) {
            if (atom !is TfImage && atom !is TfDivider && atom !is TfWikilink) continue
            e.setSpan(atom, e.getSpanStart(atom), e.getSpanEnd(atom), e.getSpanFlags(atom))
        }
    } finally {
        applying = false
    }
    requestImageLoads()
}
