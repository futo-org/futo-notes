package com.futo.notes.textfirst

import android.text.Spanned

/**
 * Where the text of the item a plain line at list [depth] continues starts, as a leading margin: the nearest item above,
 * one level out, as styled. Lines between them with no row (a blank line, which the engine keeps in the list) are passed
 * over; null when a line of a lesser level, or the note's start, comes first. UI thread.
 */
internal fun continuedTextStart(text: Spanned, lineStart: Int, depth: Int): Int? {
    var at = lineStart
    repeat(CONTINUED_LINES_SEARCHED) {
        if (at <= 0) return null
        var above = at - 1
        while (above > 0 && text[above - 1] != '\n') above--
        at = above
        val upTo = minOf(above + 1, text.length)
        val item = text.getSpans(above, upTo, TfList::class.java).firstOrNull()
        val plain = text.getSpans(above, upTo, TfIndent::class.java).firstOrNull()
        val level = item?.depth ?: plain?.depth ?: return@repeat
        if (level < depth - 1) return null
        if (item != null && level == depth - 1) return item.hanging
    }
    return null
}

private const val CONTINUED_LINES_SEARCHED = 500
