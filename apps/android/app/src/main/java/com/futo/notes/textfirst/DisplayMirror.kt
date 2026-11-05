package com.futo.notes.textfirst

import java.text.BreakIterator
import uniffi.futo_notes_ffi.EditorByteRange

/**
 * The editor thread's copy of the display text, as the keyboard sees it:
 * every accepted engine change plus any marked composition, the selection,
 * and the UTF-16 ⇄ UTF-8 index that converts engine byte ranges. Editor
 * thread only.
 */
internal class DisplayMirror {
    /** Marked text over the committed range `[start, start + original.length)`. */
    class Overlay(val start: Int, val original: String, var marked: String)

    val text = StringBuilder()
    private var index = DisplayIndex(text)
    var selStart = 0
    var selEnd = 0
    var overlay: Overlay? = null

    val composingStart get() = overlay?.start ?: -1
    val composingEnd get() = overlay?.let { it.start + it.marked.length } ?: -1
    val utf8Length: Int get() = index.utf8Length

    fun reset(display: String) {
        text.setLength(0)
        text.append(display)
        index = DisplayIndex(text)
    }

    fun toUtf16(byte: Int): Int = index.byteToUtf16(text, byte)
    fun toByte(utf16: Int): Int = index.utf16ToByte(text, utf16)

    fun replace(start: Int, end: Int, value: String, edits: MutableList<TextEdit>) {
        text.replace(start, end, value)
        index.replace(text, start, end, value.length)
        if (start != end || value.isNotEmpty()) edits.add(TextEdit(start, end, value))
    }

    fun byteRange(start: Int, end: Int) =
        EditorByteRange(toByte(start).toULong(), toByte(end).toULong())

    fun previousGrapheme(offset: Int): Int {
        if (offset == 0) return 0
        val from = maxOf(0, offset - 64)
        val it = BreakIterator.getCharacterInstance()
        it.setText(text.substring(from, offset))
        return from + it.preceding(offset - from).coerceAtLeast(0)
    }

    fun nextGrapheme(offset: Int): Int {
        if (offset >= text.length) return text.length
        val to = minOf(text.length, offset + 64)
        val it = BreakIterator.getCharacterInstance()
        it.setText(text.substring(offset, to))
        val next = it.following(0)
        return if (next == BreakIterator.DONE) to else offset + next
    }
}
