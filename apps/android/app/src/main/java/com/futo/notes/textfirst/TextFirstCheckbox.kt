package com.futo.notes.textfirst

/** The line-start offset of a task row whose checkbox is under (x, y), or -1. */
internal fun checkboxAt(view: TextFirstEditText, style: TextFirstStyle, x: Float, y: Float): Int {
    val layout = view.layout ?: return -1
    val line = layout.getLineForVertical((y - view.totalPaddingTop + view.scrollY).toInt())
    val start = layout.getLineStart(line)
    val e = view.editableText ?: return -1
    val list = e.getSpans(start, start, TfList::class.java).firstOrNull { it.marker == ListMarker.Task && it.first && e.getSpanStart(it) == start }
        ?: return -1
    val paragraphLeft = layout.getParagraphLeft(line)
    val lineX = x - view.totalPaddingLeft
    val withinMarker = lineX <= paragraphLeft + style.dp(4f) && lineX >= paragraphLeft - style.listIndent - style.dp(8f)
    return if (withinMarker && list.first) start else -1
}
