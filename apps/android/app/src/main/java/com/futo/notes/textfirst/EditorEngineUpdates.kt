package com.futo.notes.textfirst

import android.os.SystemClock
import android.util.Log
import uniffi.futo_notes_ffi.EditorViewChange

/** A source change is applied immediately and in order; rendering never gates later keyboard input. */
internal fun EditorEngine.acceptViewChange(change: EditorViewChange) {
    engineNanos = SystemClock.elapsedRealtimeNanos()
    check(change.previousRevision == rev) { "change ${change.previousRevision} applied at $rev" }
    val shownBefore = tailStart()
    val edits = ArrayList<TextEdit>(2)
    mirror.overlay?.let { overlay ->
        mirror.replace(overlay.start, overlay.start + overlay.marked.length, overlay.original, edits)
        mirror.overlay = null
    }
    val start = mirror.toUtf16(change.range.start.toInt())
    val end = mirror.toUtf16(change.range.end.toInt())
    if (TextFirstEditText.PROFILE) Log.i(EditorEngine.TAG, "change ${change.previousRevision}->${change.revision}: replace [$start,$end) with ${change.inserted.length} chars; projection ${change.projection.range.end - change.projection.range.start} bytes, ${change.projection.blocks.size} blocks, ${change.projection.runs.size} runs; parsed=${change.parsedSourceBytes}")
    renderWork.map(TextEdit(start, end, change.inserted))
    mirror.replace(start, end, change.inserted, edits)
    rev = change.revision
    mirror.selStart = mirror.toUtf16(change.selection.start.toInt())
    mirror.selEnd = mirror.toUtf16(change.selection.end.toInt())
    verify()
    val needsReset = requiresPrefixReset(edits, shownBefore)
    if (needsReset) {
        resetViewProgressively(edits, sourceChanged = true)
    } else {
        // A visible edit changes the shown prefix length, while the unseen
        // suffix remains the same number of characters behind it.
        val shown = tailStart()
        val a = mirror.toUtf16(change.projection.range.start.toInt()).coerceAtMost(shown)
        val b = mirror.toUtf16(change.projection.range.end.toInt()).coerceAtMost(shown)
        if (b - a > OpenSlices.NEXT_CHARS * 2) {
            renderWork.dirty(a, b)
            val focus = if (edits.isEmpty()) emptyList() else {
                val from = (mirror.selStart - OpenSlices.FIRST_CHARS / 2).coerceIn(a, b)
                val to = (from + OpenSlices.FIRST_CHARS).coerceAtMost(b)
                listOf(projectWindow(from, to))
            }
            postUpdate(edits, focus, sourceChanged = true, paced = true)
        } else {
            val window = if (change.projection.range.end.toInt() <= mirror.toByte(shown)) window(change.projection) else projectWindow(a, b)
            postUpdate(edits, listOf(window), sourceChanged = true)
        }
        streamTail()
    }
    armSave()
}
