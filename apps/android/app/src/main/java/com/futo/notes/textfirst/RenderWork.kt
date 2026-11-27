package com.futo.notes.textfirst

/** Worker-owned pending renderer work; all coordinates are committed display UTF-16. */
internal class RenderWork {
    var generation = 0L; private set
    var awaitingUi = false
    var styleStart = 0
    var styleEnd = 0
    /** The view is touched or shows its text menu: background slices wait. Not cleared by [reset]. */
    var held = false
    val stylesPending get() = styleStart < styleEnd
    fun reset() { generation++; awaitingUi = false; styleStart = 0; styleEnd = 0 }
    fun dirty(start: Int, end: Int) {
        if (end <= start) return
        if (stylesPending) { styleStart = minOf(styleStart, start); styleEnd = maxOf(styleEnd, end) }
        else { styleStart = start; styleEnd = end }
    }
    fun map(edit: TextEdit) {
        if (!stylesPending) return
        fun moved(at: Int, end: Boolean): Int = when {
            at < edit.start -> at
            at >= edit.end -> at + edit.text.length - (edit.end - edit.start)
            end -> edit.start + edit.text.length
            else -> edit.start
        }
        styleStart = moved(styleStart, false)
        styleEnd = moved(styleEnd, true)
    }
}

/** Whether ordered renderer deltas each land inside the [shown] prefix the view holds when they arrive. */
internal fun fitsShownPrefix(edits: List<TextEdit>, shown: Int): Boolean {
    var available = shown
    for (edit in edits) {
        if (edit.end > available) return false
        available += edit.text.length - (edit.end - edit.start)
    }
    return true
}

/** Decide whether ordered renderer deltas still fit the prefix they are applied against, and are small enough to apply. */
internal fun requiresPrefixReset(edits: List<TextEdit>, shown: Int): Boolean =
    !fitsShownPrefix(edits, shown) ||
        edits.any { it.text.length > OpenSlices.NEXT_CHARS * 2 || it.end - it.start > OpenSlices.NEXT_CHARS * 2 }

/** A renderer prefix may cut a long marked line, but never a UTF-16 surrogate pair. */
internal fun rawPrefixEnd(text: CharSequence, limit: Int): Int {
    val end = minOf(text.length, limit)
    return if (end > 0 && end < text.length && text[end - 1].isHighSurrogate() && text[end].isLowSurrogate()) end - 1 else end
}
