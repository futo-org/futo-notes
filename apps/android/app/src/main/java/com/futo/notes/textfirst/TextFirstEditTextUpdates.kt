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
    // The note changed under a drag (its revision moved): it ends at once with nothing moved.
    blockLift.revisionSeen(update.revision)
    if (update.append) { applyAppend(update); scheduleRestore(); return }
    if (update.styleOnly) { applyStyleSlice(update); return }
    // A caret the editor moved on its own, with no text: the reader stays where they are.
    if (update.reset == null && update.preserveScroll) reveal.hold(update.selStart, update.selEnd)
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
    val nativeStart = selectionStart
    val nativeEnd = selectionEnd
    val restyleOnly = update.reset == null && update.edits.all { it.start == it.end && it.text.isEmpty() }
    // A restyle keeps the reader's top line where it was, as a style slice does.
    val anchor = if (restyleOnly && update.windows.isNotEmpty() && restoring == null) scrollAnchor() else null
    // Renderer notifications can sort Android's anchor/focus even when only
    // spans change. Rust owns the range; Android retains its direction.
    val keepDirection = restyleOnly &&
        nativeStart >= 0 && nativeEnd >= 0 &&
        minOf(nativeStart, nativeEnd) == minOf(update.selStart, update.selEnd) &&
        maxOf(nativeStart, nativeEnd) == maxOf(update.selStart, update.selEnd)
    // Only a key or the keyboard's input reveals the caret it edits at again; a checkbox toggled or a format applied
    // elsewhere leaves the reader where they are (Mason: a checkbox tap put the note at its top, at the caret). Counted
    // before the edit: the TextView reveals the moved caret while the edit is applied.
    if (update.keyed && update.edits.isNotEmpty()) reveal.edited()
    val applyStart = android.os.SystemClock.elapsedRealtimeNanos()
    var editsEnd = applyStart
    val wasApplying = applying
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
            val windows = tableEditWindows(update)
            beginBatchEdit()
            var t1 = t0
            try {
                e.withRendererUpdate(this, update, windows) { change ->
                    val previousPhotos = e.photoSpansToReuse(change, windows)
                    for (edit in update.edits) e.replace(edit.start, edit.end, edit.text)
                    t1 = System.nanoTime()
                    editsEnd = android.os.SystemClock.elapsedRealtimeNanos()
                    for (window in windows) restyle(e, window, previousPhotos)
                    update.marked?.let { restyleMarked(e, update.composingStart, update.composingEnd, it) }
                }
            } finally {
                endBatchEdit()
            }
            if (TextFirstEditText.PROFILE) {
                val t2 = System.nanoTime()
                android.util.Log.i("TextFirstApply", "replace=${(t1 - t0) / 1000}us restyle+batch=${(t2 - t1) / 1000}us windows=${update.windows.map { it.end - it.start }}")
            }
        }
        if (!restyleOnly) codeTouch.forgetCopied()
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
        selectedCodeBlock = update.selectedBlock
        settlingFromEngine = !keepDirection
        try {
            Selection.setSelection(e,
                (if (keepDirection) nativeStart else update.selStart).coerceIn(0, length),
                (if (keepDirection) nativeEnd else update.selEnd).coerceIn(0, length))
        } finally { settlingFromEngine = false }
        // The paint of a range kept across an edit was resolved against the old text.
        if (update.edits.isNotEmpty() && selectionStart != selectionEnd) paintCodeSelection(selectionStart, selectionEnd, settled = true)
        codeTouch.headerField.followEngine(update)
        if (update.writesLanguage) codeTouch.openLanguageAt(update.selStart)
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
        applying = wasApplying
    }
    anchor?.let { anchorY(it)?.let { y -> if (y != scrollY) scrollTo(scrollX, y) } }
    update.drop?.let { hold ->
        // A dropped block landed: the caret it carried is not revealed, and the note holds its place.
        reveal.hold(selectionEnd, selectionStart)
        if (hold.offset >= 0) holdDropLine(hold)
        blockLift.landed(update.revision)
    }
    onApplyMeasured?.invoke(KeyTimings(
        update.inputUptimeNanos, update.postedNanos, update.engineNanos,
        applyStart, editsEnd, android.os.SystemClock.elapsedRealtimeNanos(),
    ), update)
    if (update.reset != null) { requestImageLoads(); scheduleRestore() }
}


private class ComposingUnderline : UnderlineSpan()
