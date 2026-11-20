package com.futo.notes.textfirst

/** The line-start offset of a task row whose checkbox is under (x, y), or -1. */
internal fun checkboxAt(view: TextFirstEditText, style: TextFirstStyle, x: Float, y: Float): Int {
    val layout = view.layout ?: return -1
    val localY = y - view.totalPaddingTop + view.scrollY
    if (localY < 0 || localY >= layout.height) return -1
    val line = layout.getLineForVertical(localY.toInt())
    val start = layout.getLineStart(line)
    val e = view.editableText ?: return -1
    val box = e.getSpans(start, minOf(start + 1, e.length), TfListMarker::class.java)
        .firstOrNull { it.marker == ListMarker.Task && e.getSpanStart(it) == start } ?: return -1
    // The checkbox is the item's marker unit, its first character: the text starts where the unit ends, on the
    // paragraph's right for right-to-left text.
    val dir = layout.getParagraphDirection(line)
    val textEdge = layout.getPrimaryHorizontal(start + 1)
    val withinMarker = onTaskCheckbox(x - view.totalPaddingLeft, textEdge, dir, box.width.toFloat(), style.dp(8f))
    return if (withinMarker) start else -1
}

/**
 * Whether [lineX] falls on a task checkbox whose text starts at [contentEdge] in a paragraph
 * running in [dir] (1 left-to-right, -1 right-to-left): anywhere on the marker unit before
 * the text, [indent] wide, or [reach] past its far side. A touch on the text itself, even its
 * first letter, places the caret instead.
 */
internal fun onTaskCheckbox(lineX: Float, contentEdge: Float, dir: Int, indent: Float, reach: Float): Boolean {
    val intoMargin = (contentEdge - lineX) * dir
    return intoMargin > 0f && intoMargin <= indent + reach
}
