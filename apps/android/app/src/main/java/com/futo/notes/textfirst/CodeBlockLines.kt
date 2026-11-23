package com.futo.notes.textfirst

/** The layout top and bottom of [block]'s code lines; its header is drawn inside its first line's box. */
internal fun TextFirstEditText.codeBlockLines(block: Pair<Int, Int>): Pair<Int, Int>? {
    val l = layout ?: return null
    return l.getLineTop(l.getLineForOffset(block.first)) to l.getLineBottom(l.getLineForOffset(maxOf(block.first, block.second - 1)))
}
