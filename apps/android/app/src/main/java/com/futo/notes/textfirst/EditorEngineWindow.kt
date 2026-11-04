package com.futo.notes.textfirst

import uniffi.futo_notes_ffi.EditorProjection

/** One engine projection as a restyle window in the view's UTF-16 offsets. Editor thread. */
internal fun EditorEngine.window(projection: EditorProjection): StyleWindow {
    val start = mirror.toUtf16(projection.range.start.toInt())
    val end = mirror.toUtf16(projection.range.end.toInt())
    val w0 = System.nanoTime()
    val grid = tableSpans(projection)
    val w1 = System.nanoTime()
    val planned = planSpans(projection, start) { mirror.toUtf16(it) }
    val w2 = System.nanoTime()
    val specs = planned.filter { spec ->
        grid.none { spec.start >= it.start && spec.end <= it.end }
    } + grid
    val w3 = System.nanoTime()
    if (projection.blocks.size > 1000) android.util.Log.i("TextFirstOpen", "window tableSpans=${(w1 - w0) / 1000000} plan=${(w2 - w1) / 1000000} filter=${(w3 - w2) / 1000000} grid=${grid.size} planned=${planned.size}")
    // A block may reach past the reparsed window; the restyle covers it
    // whole, so its old span is replaced rather than kept beside the new.
    return StyleWindow(minOf(start, specs.minOfOrNull { it.start } ?: start), maxOf(end, specs.maxOfOrNull { it.end } ?: end), specs)
}
