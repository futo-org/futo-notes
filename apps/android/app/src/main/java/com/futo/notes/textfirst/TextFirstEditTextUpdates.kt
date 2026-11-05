package com.futo.notes.textfirst

import android.text.Selection
import android.text.Spanned
import android.text.style.UnderlineSpan
import android.widget.TextView.BufferType

/** Apply one ordered engine update to the text, spans, composition and native selection together. */
internal fun TextFirstEditText.applyEngineUpdate(update: UiUpdate) {
    // Cut short for a new width (TextFirstEditTextWidth.kt): deltas made against
    // the dropped text no longer fit, and a reset brings their result.
    if (awaitingRelayout) {
        if (update.reset == null) return
        awaitingRelayout = false
    }
    contentComplete = update.complete
    if (update.append) { applyAppend(update); scheduleRestore(); return }
    if (update.styleOnly) { applyStyleSlice(update); return }
    if (update.reset != null && update.preserveScroll) {
        scrollAnchor()?.let { before ->
            var offset = before.offset
            for (edit in update.edits) offset = when {
                offset < edit.start -> offset
                offset >= edit.end -> offset + edit.text.length - (edit.end - edit.start)
                else -> edit.start + minOf(offset - edit.start, edit.text.length)
            }
            restoring = ScrollAnchor(offset, before.intoLine)
        }
    }
    val applyStart = android.os.SystemClock.elapsedRealtimeNanos()
    var editsEnd = applyStart
    applying = true
    try {
        val reset = update.reset
        if (reset != null) {
            // Chunk first, then style: one whole-note SpannableStringBuilder
            // re-sorts its entire span table on every setSpan (quadratic open).
            val built = ChunkedEditable.from(reset + TextFirstEditText.END_SENTINEL)
            for (window in update.windows) addSpans(built, window.specs)
            setText(built, BufferType.EDITABLE)
        } else {
            val e = editableText
            val t0 = System.nanoTime()
            beginBatchEdit()
            var t1 = t0
            try {
                e.withRendererUpdate(update) {
                    for (edit in update.edits) e.replace(edit.start, edit.end, edit.text)
                    t1 = System.nanoTime()
                    editsEnd = android.os.SystemClock.elapsedRealtimeNanos()
                    for (window in update.windows) restyle(e, window)
                }
            } finally {
                endBatchEdit()
            }
            if (TextFirstEditText.PROFILE) {
                val t2 = System.nanoTime()
                android.util.Log.i("TextFirstApply", "replace=${(t1 - t0) / 1000}us restyle+batch=${(t2 - t1) / 1000}us windows=${update.windows.map { it.end - it.start }}")
            }
        }
        reveal.edited()
        val e = editableText
        // Not BaseInputConnection.removeComposingSpans: it lists every span in the note.
        composing?.let(e::removeSpan)
        composing = null
        if (update.composingStart >= 0 && update.composingEnd > update.composingStart && update.composingEnd <= e.length - 1) {
            composing = ComposingUnderline().also {
                e.setSpan(it, update.composingStart, update.composingEnd, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE or Spanned.SPAN_COMPOSING)
            }
        }
        val length = (e.length - 1).coerceAtLeast(0)
        Selection.setSelection(e, update.selStart.coerceIn(0, length), update.selEnd.coerceIn(0, length))
        appliedSeq = update.seq
        if (update.inputUptimeNanos != 0L && (update.reset == null || update.sourceChanged)) {
            pendingTimings = KeyTimings(
                input = update.inputUptimeNanos,
                posted = update.postedNanos,
                engine = update.engineNanos,
                applyStart = applyStart,
                editsEnd = editsEnd,
                applyEnd = android.os.SystemClock.elapsedRealtimeNanos(),
            )
        }
    } finally {
        applying = false
    }
    onApplyMeasured?.invoke(KeyTimings(
        update.inputUptimeNanos, update.postedNanos, update.engineNanos,
        applyStart, editsEnd, android.os.SystemClock.elapsedRealtimeNanos(),
    ), update)
    if (update.reset != null) { requestImageLoads(); scheduleRestore() }
}


private class ComposingUnderline : UnderlineSpan()
