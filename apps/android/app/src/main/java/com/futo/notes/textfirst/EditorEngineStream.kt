package com.futo.notes.textfirst

import android.os.SystemClock
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
    /**
     * How deep a returning reader's first slice may reach. Past it the note
     * streams from the top and the view jumps once the saved line arrives, so
     * a very deep position never costs more than this before something shows.
     */
    const val REACH_BACK_CHARS = 120_000
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

/** Schedule one bounded unit only after the previous UI apply acknowledged it. */
internal fun EditorEngine.streamTail(delay: Long = OpenSlices.GAP_MS) {
    handler.removeCallbacks(tailRunnable)
    if (!closed && !renderWork.awaitingUi && mirror.overlay == null && (streaming || renderWork.stylesPending)) handler.postDelayed(tailRunnable, delay)
}

internal fun EditorEngine.stopStreaming() {
    handler.removeCallbacks(tailRunnable)
    tailLength = 0
    renderWork.reset()
}

internal fun EditorEngine.projectWindow(from: Int, end: Int): StyleWindow {
    val s = checkNotNull(session)
    return window(s.project(rev, mirror.byteRange(from, end)))
}

internal fun EditorEngine.showNextRenderSlice() {
    if (closed || renderWork.awaitingUi || mirror.overlay != null) return
    try {
        if (renderWork.stylesPending) {
            val from = renderWork.styleStart
            val end = minOf(renderWork.styleEnd, OpenSlices.sliceEnd(mirror.text, from, OpenSlices.NEXT_CHARS))
            val window = projectWindow(from, end)
            renderWork.styleStart = end
            postRenderUpdate(UiUpdate(
                seq, null, emptyList(), mirror.selStart, mirror.selEnd,
                mirror.composingStart, mirror.composingEnd, listOf(window), 0L,
                complete = !streaming && !renderWork.stylesPending, styleOnly = true,
            ))
        } else showNextSlice()
    } catch (error: EditorSessionException) {
        handleFailure(error)
        reloadFromEngine()
    }
}

/** Show one text slice. A provisional overlay has different coordinates from Rust's committed text. */
internal fun EditorEngine.showNextSlice(chars: Int = OpenSlices.NEXT_CHARS, force: Boolean = false) {
    if (session == null) return
    if (closed || !streaming || mirror.overlay != null || !force && renderWork.awaitingUi) return
    val from = tailStart()
    val end = OpenSlices.sliceEnd(mirror.text, from, chars)
    try {
        val window = projectWindow(from, end)
        tailLength = mirror.text.length - end
        postAppend(listOf(TextEdit(from, from, mirror.text.substring(from, end))), listOf(window))
    } catch (e: EditorSessionException) {
        handleFailure(e)
        reloadFromEngine()
    }
}

/** Legacy deep Find/cell navigation still needs its target laid out before revealing it. */
internal fun EditorEngine.finishStreaming() {
    handler.removeCallbacks(tailRunnable)
    if (streaming) showNextSlice(Int.MAX_VALUE / 2, force = true)
}

/** A self-contained bounded prefix supersedes old render work, never the canonical source. */
internal fun EditorEngine.resetViewProgressively(edits: List<TextEdit> = emptyList(), sourceChanged: Boolean = false) {
    check(mirror.overlay == null)
    handler.removeCallbacks(tailRunnable)
    renderWork.reset()
    val shown = OpenSlices.sliceEnd(mirror.text, 0, OpenSlices.FIRST_CHARS)
    tailLength = mirror.text.length - shown
    postUpdate(edits, listOf(projectWindow(0, shown)), reset = mirror.text.substring(0, shown), sourceChanged = sourceChanged, preserveScroll = true, paced = true)
}

/** Oversized marked text stays provisional: show a raw bounded prefix without querying committed offsets. */
internal fun EditorEngine.resetMarkedView(edits: List<TextEdit>) {
    check(mirror.overlay != null)
    handler.removeCallbacks(tailRunnable)
    renderWork.reset()
    val shown = rawPrefixEnd(mirror.text, OpenSlices.FIRST_CHARS)
    tailLength = mirror.text.length - shown
    postUpdate(edits, emptyList(), reset = mirror.text.substring(0, shown), preserveScroll = true, paced = true)
}

/** Append without replacing a newer touch selection; the view extends only its still-clipped range. */
internal fun EditorEngine.postAppend(edits: List<TextEdit>, windows: List<StyleWindow>) {
    postRenderUpdate(UiUpdate(
        seq, null, edits, mirror.selStart, mirror.selEnd,
        mirror.composingStart, mirror.composingEnd, windows, 0L,
        append = true, complete = !streaming && !renderWork.stylesPending,
    ))
}

/** FIFO applies remain valid. Only an obsolete acknowledgement after a self-contained reset is ignored. */
internal fun EditorEngine.postRenderUpdate(update: UiUpdate) {
    val generation = renderWork.generation
    renderWork.awaitingUi = true
    ui.post {
        val began = SystemClock.uptimeMillis()
        sink.onUpdate(update)
        val took = SystemClock.uptimeMillis() - began
        handler.post {
            if (!closed && renderWork.generation == generation) {
                renderWork.awaitingUi = false
                streamTail(maxOf(OpenSlices.GAP_MS, took))
            }
        }
    }
}
