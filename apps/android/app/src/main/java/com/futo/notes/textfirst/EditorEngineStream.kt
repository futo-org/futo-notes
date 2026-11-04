package com.futo.notes.textfirst

import uniffi.futo_notes_ffi.EditorSessionException

// Progressive open: a long note shows its first screens at once and the rest
// follows in slices, so opening costs the size of what is on screen rather
// than of the whole note. The engine already holds the whole note and the
// mirror its whole display; only the view lags, by [EditorEngine.tailLength]
// characters at the end. Editor thread.

internal object OpenSlices {
    /** About a screen and a half of lines: what shows before anything streams. */
    const val FIRST_CHARS = 6_000
    /** Small enough that one slice's layout never holds the UI thread for long on a low-end phone. */
    const val NEXT_CHARS = 8_000
    /** Between slices, so touches and scrolls are served in the gaps. */
    const val GAP_MS = 16L
    /** How far past its target a slice may run to reach a blank line. */
    private const val REACH = 10
    private const val BLANK_LINE = "\n\n"

    /**
     * Where a slice starting at [from] ends: just after the line before the
     * first blank line past [chars], else the end of the text. A blank line
     * ends every block that spans lines (a table, a paragraph, an inline
     * mark), so no block is cut in two: the engine reports a table only from
     * the slice it starts in, and a cut table would never be styled. A text
     * with no blank line within reach keeps whole lines.
     */
    fun sliceEnd(text: StringBuilder, from: Int, chars: Int): Int {
        val target = from + chars
        if (target >= text.length) return text.length
        val blank = text.indexOf(BLANK_LINE, target - 1)
        if (blank >= 0 && blank + 1 - target <= chars * REACH) return blank + 1
        val line = text.indexOf("\n", target)
        return if (line < 0) text.length else line + 1
    }
}

/** True while the view shows less than the whole note. */
internal val EditorEngine.streaming get() = tailLength > 0

internal fun EditorEngine.tailStart() = mirror.text.length - tailLength

/** Schedule the next slice [delay] ms from now, if any is left. */
internal fun EditorEngine.streamTail(delay: Long = OpenSlices.GAP_MS) {
    handler.removeCallbacks(tailRunnable)
    if (streaming && !closed) handler.postDelayed(tailRunnable, delay)
}

internal fun EditorEngine.stopStreaming() {
    handler.removeCallbacks(tailRunnable)
    tailLength = 0
}

/** Show the next slice. */
internal fun EditorEngine.showNextSlice(chars: Int = OpenSlices.NEXT_CHARS) {
    val s = session ?: return
    if (closed || !streaming) return
    val from = tailStart()
    val end = OpenSlices.sliceEnd(mirror.text, from, chars)
    try {
        val projection = s.project(rev, mirror.byteRange(from, end))
        val window = window(projection)
        tailLength = mirror.text.length - end
        postAppend(listOf(TextEdit(from, from, mirror.text.substring(from, end))), listOf(window))
        return
    } catch (e: EditorSessionException) {
        // The note stays complete in the engine; show it whole rather than leave a stub.
        handleFailure(e)
        stopStreaming()
        reloadFromEngine()
    }
}

/** Show everything still unshown, before anything that may reach it. */
internal fun EditorEngine.finishStreaming() {
    handler.removeCallbacks(tailRunnable)
    if (streaming) showNextSlice(Int.MAX_VALUE / 2)
}
