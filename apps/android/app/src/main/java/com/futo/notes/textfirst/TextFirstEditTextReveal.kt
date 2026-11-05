package com.futo.notes.textfirst

/**
 * When the note view scrolls to meet its caret.
 *
 * TextView reveals the caret in a pre-draw, but while a layout is pending it only remembers
 * the offset for onLayout, where the pending layout still reads as pending and the reveal is
 * deferred again. Any key that grows the note (Enter, a wrapped line) has a layout pending,
 * and Compose's AndroidView keeps requesting one while it lays the view out, so the reveal
 * waited for whatever next registered a pre-draw (the cursor blink, 500 ms later), the caret
 * sitting off screen or cut by the bottom edge meanwhile. The text layout is current by the
 * time a key lands, so [at] reveals against it at once, whatever layout is pending.
 *
 * That late pre-draw is also a second reveal of the same caret, and it throws a note the
 * reader has scrolled away from the caret (to read, right after typing) back to it. A caret
 * is revealed once per move or edit: the same offset with no edit since is not revealed again
 * unless [again] says the view shrank under it.
 */
internal class CaretReveal {
    /** True while a reveal runs: the view then reports no pending layout. */
    var ignoringLayout = false
        private set
    private var offset = -1
    /** The selection's other end, when a range was held: TextView reveals its start and its end. */
    private var other = -1
    private var edits = 0
    private var revealedEdits = -1

    /** The engine changed the text. */
    fun edited() { edits += 1 }

    /** The view shrank (the keyboard rose) under a caret that was on screen: reveal it again. */
    fun again() { offset = -1; other = -1 }

    /** Count [offset] (and a range's [other] end) as revealed without scrolling: the reader was put elsewhere on purpose. */
    fun hold(offset: Int, other: Int = offset) {
        this.offset = offset
        this.other = other
        revealedEdits = edits
    }

    /** While true, nothing is revealed: the selection is moving with text the stream appends. */
    var quiet = false

    fun at(offset: Int, ready: Boolean, reveal: () -> Boolean): Boolean {
        if (!ready || quiet || ((offset == this.offset || offset == other) && edits == revealedEdits)) return false
        this.offset = offset
        other = offset
        revealedEdits = edits
        ignoringLayout = true
        try { return reveal() } finally { ignoringLayout = false }
    }
}

/**
 * Whether the caret's line was inside a view [viewHeight] tall at the current scroll: the
 * keyboard rising over a caret that was on screen reveals it again, and a note the reader
 * has scrolled away from the caret is never pulled back to it.
 */
internal fun TextFirstEditText.caretWasInView(viewHeight: Int): Boolean {
    val l = layout ?: return false
    if (selectionEnd < 0) return false
    val line = l.getLineForOffset(selectionEnd)
    return l.getLineTop(line) + totalPaddingTop >= scrollY && l.getLineBottom(line) + totalPaddingTop <= scrollY + viewHeight
}

/** A whole-note selection changes the selected range without moving the reader to its end. */
internal fun TextFirstEditText.revealCaret(offset: Int, nativeReveal: () -> Boolean): Boolean {
    // The reader is being put back on their line (an open, a new width); the caret stays where it is.
    if (restoring != null) return false
    val end = (editableText?.length ?: 0) - 1
    if (end > 0 && minOf(selectionStart, selectionEnd) == 0 && maxOf(selectionStart, selectionEnd) == end) return false
    return reveal.at(offset, ready = layout != null && height > 0, reveal = nativeReveal)
}
