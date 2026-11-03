package com.futo.notes.textfirst

import uniffi.futo_notes_ffi.EditorProjection

/** One engine projection as a restyle window in the view's UTF-16 offsets. Editor thread. */
internal fun EditorEngine.window(projection: EditorProjection): StyleWindow {
    val start = mirror.toUtf16(projection.range.start.toInt())
    val end = mirror.toUtf16(projection.range.end.toInt())
    val specs = planSpans(projection, start) { mirror.toUtf16(it) }
    // A block may reach past the reparsed window; the restyle covers it
    // whole, so its old span is replaced rather than kept beside the new.
    return StyleWindow(minOf(start, specs.minOfOrNull { it.start } ?: start), maxOf(end, specs.maxOfOrNull { it.end } ?: end), specs)
}
