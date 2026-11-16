package com.futo.notes.textfirst

import uniffi.futo_notes_ffi.EditorProjection

/**
 * The engine's style plan for the whole lines around [from, to), as a restyle window in the
 * view's UTF-16 offsets. The engine clips its spans to the range it is asked for, so asking for
 * whole lines keeps each line's block span and list marker in one piece. Editor thread, with no
 * composition overlay: the plan is in the engine's display, which the mirror equals only then.
 * Code languages come from [projection] when the caller already holds one covering the window
 * (an accepted change), else from a projection of the window.
 */
internal fun EditorEngine.planStyleWindow(from: Int, to: Int, projection: EditorProjection? = null): StyleWindow {
    val start = lineStartAt(mirror.text, from)
    val end = lineEndAfter(mirror.text, start, to)
    val session = checkNotNull(session)
    val range = mirror.byteRange(start, end)
    val planned = session.stylePlan(rev, range).toStyleWindow(start, end, mirror.text)
    return planned.withCodeLanguages(projection ?: session.project(rev, range), mirror::toUtf16)
}

internal fun EditorEngine.planStyleWindow(projection: EditorProjection): StyleWindow =
    planStyleWindow(mirror.toUtf16(projection.range.start.toInt()), mirror.toUtf16(projection.range.end.toInt()), projection)

private fun lineStartAt(text: CharSequence, offset: Int): Int = text.lastIndexOf('\n', offset - 1) + 1

/** An empty range still names the line it sits on. */
private fun lineEndAfter(text: CharSequence, start: Int, offset: Int): Int {
    if (offset > start && text[offset - 1] == '\n') return offset
    val lineBreak = text.indexOf('\n', offset)
    return if (lineBreak < 0) text.length else lineBreak + 1
}
