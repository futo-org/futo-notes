package com.futo.notes.textfirst

import android.text.Selection

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

    /** An edit came since the last reveal: the next one is for it. */
    val editPending get() = edits != revealedEdits

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
    // A selected block is where its header is, a photo selected whole where its top is.
    val offset = selectedCodeBlock?.first ?: selectedObject?.first ?: selectionEnd
    if (offset < 0) return false
    val line = l.getLineForOffset(offset)
    if (selectedObject != null) return l.getLineTop(line) + totalPaddingTop >= scrollY && l.getLineTop(line) + totalPaddingTop + lineHeight <= scrollY + viewHeight
    return l.getLineTop(line) + totalPaddingTop >= scrollY && l.getLineBottom(line) + totalPaddingTop <= scrollY + viewHeight
}

/**
 * A whole-note selection changes the selected range without moving the reader to its end. A code block selected as
 * one object is revealed whole, from its header, or from its header down when it is taller than the space.
 */
internal fun TextFirstEditText.revealCaret(offset: Int, nativeReveal: () -> Boolean): Boolean {
    // The reader is being put back on their line (an open, a new width); the caret stays where it is.
    if (restoring != null || caretEdge.isDriving) return false
    selectedCodeBlock?.let { block ->
        return reveal.at(block.first, ready = layout != null && height > 0) {
            val (top, bottom) = codeBlockLines(block) ?: return@at false
            revealAreaAboveKeyboard(top.toFloat(), bottom.toFloat())
        }
    }
    // A code block's header field has the keyboard: the note's own caret is not where the reader is (CodeHeaderField).
    if (codeTouch.headerField.openField != null) return false
    val end = (editableText?.length ?: 0) - 1
    // A note that is one photo: the photo selected whole is the whole note, and is revealed as a photo.
    if (selectedObject == null && end > 0 && minOf(selectionStart, selectionEnd) == 0 && maxOf(selectionStart, selectionEnd) == end) return false
    // Typing (a key, Backspace, Enter, a paste) beside a photo reveals the typed text, not the photo's top.
    val typed = reveal.editPending
    // A photo selected whole is revealed once for itself, keyed by its start, though the caret was revealed at its end.
    return reveal.at(selectedObject?.first ?: offset, ready = layout != null && height > 0) { photoRowReveal(offset, typed) ?: nativeReveal() }
}

/**
 * A caret moved onto a loaded photo's row, or the photo selected whole, shows the row ([revealPhotoRow]), never a
 * strip of the photo with the platform's margin (a quarter of the view, below a caret as tall as the photo). After
 * [typed] text it shows where the text lands: a line's height above the row's baseline down to the row's bottom, which
 * may scroll on the first character and then stays. Null off a photo's row, where the platform reveals.
 */
private fun TextFirstEditText.photoRowReveal(offset: Int, typed: Boolean): Boolean? {
    val l = layout ?: return null
    val text = editableText ?: return null
    selectedObject?.let { (start, _) -> return revealPhotoRow(l, l.getLineForOffset(start)) }
    if (selectionStart != selectionEnd || photoBesideCaret(l, text, offset, android.graphics.RectF(), anywhere = true) == null) return null
    val line = l.getLineForOffset(offset)
    if (!typed) return revealPhotoRow(l, line)
    return revealAreaAboveKeyboard((l.getLineBaseline(line) - lineHeight).toFloat(), l.getLineBottom(line).toFloat())
}

/**
 * A photo's row, for a caret on it or the photo selected as one object (a tap), shows whole, or from its top when it is
 * taller than the space. A top already shown stays where it is: a tap on a photo on screen moves nothing until the
 * keyboard rises over its top.
 */
private fun TextFirstEditText.revealPhotoRow(l: android.text.Layout, line: Int): Boolean {
    val top = l.getLineTop(line).toFloat()
    val bottom = l.getLineBottom(line).toFloat()
    val visibleBottom = visibleBottomAboveKeyboard()
    val space = visibleBottom - totalPaddingTop
    if (bottom - top <= space) return revealAreaAboveKeyboard(top, bottom)
    val onScreenTop = totalPaddingTop - scrollY + top
    if (onScreenTop >= totalPaddingTop && onScreenTop + lineHeight <= visibleBottom) return false
    return revealAreaAboveKeyboard(top, top + space)
}

/**
 * A blur (the keyboard dropped, focus moved to the title or find bar) ends a range at its end,
 * as TextView's closing text menu does, and leaves the reader on their line: that end, often
 * far below the screen after Select All, is not revealed.
 */
internal fun TextFirstEditText.endSelectionOnBlur() {
    val end = selectionEnd
    if (end < 0) return
    reveal.hold(end)
    if (selectionStart == end) return
    // The editor ends it, not the user, so the engine keeps its own affinity at the end (a bold word stays bold there).
    movingSelectionItself = true
    try { Selection.setSelection(editableText, end) } finally { movingSelectionItself = false }
}

/**
 * A tap that leaves a caret shows its whole line, even where the caret already was. The TextView reveals only a
 * selection that changed, so a retap on a line half under the note's edge kept a clipped caret (Mason, S23).
 */
internal fun TextFirstEditText.revealTappedCaret(event: android.view.MotionEvent) {
    // A disabled note (saving on the way out) placed no caret: there is nothing to show.
    if (event.actionMasked != android.view.MotionEvent.ACTION_UP || !isEnabled) return
    if (event.eventTime - event.downTime >= android.view.ViewConfiguration.getLongPressTimeout()) return
    if (selectionStart < 0 || selectionStart != selectionEnd) return
    // A line already shown whole is left where it is: the TextView's reveal would add its own margin.
    if (caretWasInView(height - totalPaddingBottom)) return
    reveal.again()
    bringPointIntoView(selectionEnd)
}
