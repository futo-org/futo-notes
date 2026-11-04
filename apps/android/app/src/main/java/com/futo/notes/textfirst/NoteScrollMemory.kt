package com.futo.notes.textfirst

/**
 * Where a note was scrolled to: the line at the top of the view and how far
 * into it. A line, not a pixel height, because the text reflows when images
 * load and the note is laid out again on every open.
 */
internal class ScrollAnchor(val offset: Int, val intoLine: Int) {
    val atTop get() = offset == 0 && intoLine == 0
}

/**
 * The scroll position each note was left at, kept for the life of the process
 * so that returning to a note (Back to the list and in again, or the screen
 * being recreated) lands where it was left. The editor screen is rebuilt on
 * every open, so nothing there can hold it.
 */
internal object NoteScrollMemory {
    private const val LIMIT = 64
    private val anchors = object : LinkedHashMap<String, ScrollAnchor>(16, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, ScrollAnchor>) = size > LIMIT
    }

    @Synchronized fun get(noteId: String): ScrollAnchor? = anchors[noteId]

    /** A note left at its top is simply forgotten: that is where it opens. */
    @Synchronized fun put(noteId: String, anchor: ScrollAnchor?) {
        if (anchor == null || anchor.atTop) anchors.remove(noteId) else anchors[noteId] = anchor
    }

    @Synchronized fun clear() = anchors.clear()
}
