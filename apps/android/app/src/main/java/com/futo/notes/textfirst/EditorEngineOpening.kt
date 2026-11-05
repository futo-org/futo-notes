package com.futo.notes.textfirst

// While a note opens, the view may already show its quick first screens
// (EditorEngineStorage.kt) but no session exists. Taps, keys and commands
// made then wait in [EditorEngine.awaitingOpen], in order, and run once the
// whole open has installed the session. Editor thread.

/** True when [block] was queued to run after the whole open. */
internal fun EditorEngine.deferredUntilOpen(block: () -> Unit): Boolean {
    val waiting = awaitingOpen
    if (session != null || waiting == null || closed) return false
    waiting.addLast(block)
    return true
}

/** Run [block] now, or after the whole open when it has not landed yet. */
internal fun EditorEngine.whenOpen(block: () -> Unit) {
    if (!deferredUntilOpen(block)) block()
}

/**
 * A tap while the note opens: the keyboard reads the caret at once; the
 * session takes it once it exists, mapped through any edits queued before it.
 */
internal fun EditorEngine.selectWhileOpening(viewSeq: Int, start: Int, end: Int): Boolean {
    if (session != null || awaitingOpen == null) return false
    mirror.selStart = minOf(start, end).coerceIn(0, mirror.text.length)
    mirror.selEnd = maxOf(start, end).coerceIn(mirror.selStart, mirror.text.length)
    publishSelection()
    whenOpen { selectFromView(viewSeq, start, end, force = true) }
    return true
}
