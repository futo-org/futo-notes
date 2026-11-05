package com.futo.notes.textfirst

/** The line-start offset of a task row whose checkbox is under (x, y), or -1. */
internal fun checkboxAt(view: TextFirstEditText, style: TextFirstStyle, x: Float, y: Float): Int {
    val layout = view.layout ?: return -1
    val line = layout.getLineForVertical((y - view.totalPaddingTop + view.scrollY).toInt())
    val start = layout.getLineStart(line)
    val e = view.editableText ?: return -1
    val list = e.getSpans(start, start, TfList::class.java).firstOrNull { it.marker == ListMarker.Task && it.first && e.getSpanStart(it) == start }
        ?: return -1
    // The checkbox sits in the leading margin, beside where the text starts: at the
    // paragraph's left for left-to-right text, at its right for right-to-left text.
    val dir = layout.getParagraphDirection(line)
    val contentEdge = if (dir < 0) layout.getParagraphRight(line) else layout.getParagraphLeft(line)
    val withinMarker = onTaskCheckbox(x - view.totalPaddingLeft, contentEdge.toFloat(), dir, style.listIndent, style.dp(8f))
    return if (withinMarker && list.first) start else -1
}

/**
 * Whether [lineX] falls on a task checkbox whose text starts at [contentEdge] in a paragraph
 * running in [dir] (1 left-to-right, -1 right-to-left): anywhere in the leading margin before
 * the text, up to [indent] plus [reach] back from it. A touch on the text itself, even its
 * first letter, places the caret instead.
 */
internal fun onTaskCheckbox(lineX: Float, contentEdge: Float, dir: Int, indent: Float, reach: Float): Boolean {
    val intoMargin = (contentEdge - lineX) * dir
    return intoMargin > 0f && intoMargin <= indent + reach
}
