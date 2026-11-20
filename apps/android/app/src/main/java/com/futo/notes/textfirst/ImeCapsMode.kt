package com.futo.notes.textfirst

import android.text.TextUtils

/**
 * The keyboard's caps mode at [offset] of [text]. A list item's marker is one character at its line's start (the
 * engine's marker unit): an item's text starts after it, so it is judged from the line's start, as a new line is.
 */
internal fun noteCapsMode(text: CharSequence, offset: Int, reqModes: Int): Int =
    TextUtils.getCapsMode(text, capsOffset(text, offset), reqModes)

/** Where caps are judged for a caret at [offset]: before a marker unit that opens the line, else [offset] itself. */
internal fun capsOffset(text: CharSequence, offset: Int): Int {
    val at = offset.coerceIn(0, text.length)
    if (at == 0 || text[at - 1] != OBJECT_REPLACEMENT) return at
    return if (at == 1 || text[at - 2] == '\n') at - 1 else at
}

private const val OBJECT_REPLACEMENT = '\uFFFC'
