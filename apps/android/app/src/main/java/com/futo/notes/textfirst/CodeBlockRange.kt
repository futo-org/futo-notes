package com.futo.notes.textfirst

import android.text.Spanned

/**
 * The block a code line is in, from its first code line's start to its last line's end, read from the line spans'
 * first and last flags. Never from a span's block facts: a line restyled alone (typing in it) carries the block's
 * new range while its neighbours keep the old one.
 */
internal fun Spanned.codeBlockRange(line: TfCodeBlock): CodeRange {
    var head = line
    while (!head.line.first) head = neighbourCodeLine(head, before = true) ?: break
    var tail = line
    while (!tail.line.last) tail = neighbourCodeLine(tail, before = false) ?: break
    return CodeRange(getSpanStart(head), codeLineEnd(this, tail), codeLineBelow(this, tail))
}

/** The block whose code starts at [codeStart], if a block's first code line starts there. */
internal fun Spanned.codeBlockStartingAt(codeStart: Int): CodeRange? {
    if (codeStart < 0 || codeStart > length) return null
    val head = getSpans(codeStart, codeStart, TfCodeBlock::class.java).firstOrNull { it.line.first && getSpanStart(it) == codeStart } ?: return null
    return codeBlockRange(head)
}

private fun Spanned.neighbourCodeLine(line: TfCodeBlock, before: Boolean): TfCodeBlock? {
    val start = getSpanStart(line)
    val end = getSpanEnd(line)
    val at = if (before) start - 1 else end
    if (at < 0 || at > length) return null
    return getSpans(at, at, TfCodeBlock::class.java).firstOrNull {
        it !== line && if (before) getSpanStart(it) < start else getSpanStart(it) >= end
    }
}

/** Whether [line]'s block starts at or before [offset], walking back only as far as [offset]. */
internal fun Spanned.codeBlockStartsBy(line: TfCodeBlock, offset: Int): Boolean {
    var current = line
    while (true) {
        if (getSpanStart(current) <= offset) return true
        if (current.line.first) return false
        current = neighbourCodeLine(current, before = true) ?: return false
    }
}

/** Whether [line]'s block ends at or after [offset], walking forward only as far as [offset]. */
internal fun Spanned.codeBlockEndsBy(line: TfCodeBlock, offset: Int): Boolean {
    var current = line
    while (true) {
        if (codeLineEnd(this, current) >= offset) return true
        if (current.line.last) return false
        current = neighbourCodeLine(current, before = false) ?: return false
    }
}
