package com.futo.notes.textfirst

// Where the note is scrolled to: read when the reader leaves, put back when they return.

internal fun TextFirstEditText.anchorY(anchor: ScrollAnchor): Int? {
    val l = layout ?: return null
    val line = l.getLineForOffset(anchor.offset.coerceIn(0, l.text.length))
    return (l.getLineTop(line) + anchor.intoLine + totalPaddingTop).coerceIn(0, maxScrollY())
}

/** The furthest the note scrolls: its last line (and the padding under it) at the bottom edge. */
internal fun TextFirstEditText.maxScrollY(): Int {
    val l = layout ?: return 0
    return (l.height + totalPaddingTop + totalPaddingBottom - height).coerceAtLeast(0)
}

/**
 * A view that grew (the keyboard went away) with the note scrolled past its new end is left
 * showing blank space, and TextView only corrects that at its next reveal: the first tap or key
 * after the keyboard hid then moved the note under the reader's finger, so a double-tap landed
 * on a different word than its first tap. ScrollView does this clamp in its own layout.
 */
internal fun TextFirstEditText.clampScrollToNote() {
    if (restoring != null) return
    val max = maxScrollY()
    if (scrollY > max) scrollTo(scrollX, max)
}

internal fun TextFirstEditText.stopPinning() {
    pinned = null
    removeCallbacks(unpin)
}

/** The line at the top of the view and how far into it; null before there is any text to anchor to. */
internal fun TextFirstEditText.scrollAnchor(): ScrollAnchor? {
    restoring?.let { return it }
    val l = layout ?: return null
    val y = scrollY - totalPaddingTop
    if (y <= 0) return ScrollAnchor(0, 0)
    val line = l.getLineForVertical(y)
    return ScrollAnchor(l.getLineStart(line), (y - l.getLineTop(line)).coerceAtLeast(0))
}

/** Scroll to [restoring] just before the next frame, so the note is never drawn at the top first. */
internal fun TextFirstEditText.scheduleRestore() {
    if (restoring == null || restoreQueued) return
    restoreQueued = true
    viewTreeObserver.addOnPreDrawListener(object : android.view.ViewTreeObserver.OnPreDrawListener {
        override fun onPreDraw(): Boolean {
            viewTreeObserver.removeOnPreDrawListener(this)
            restoreQueued = false
            // false cancels this frame; the scroll invalidates and the next one is drawn in place.
            return !applyRestore()
        }
    })
}

internal fun TextFirstEditText.applyRestore(): Boolean {
    val anchor = restoring ?: return false
    val l = layout ?: return false
    val line = l.getLineForOffset(anchor.offset.coerceIn(0, l.text.length))
    val wanted = l.getLineTop(line) + anchor.intoLine + totalPaddingTop
    val max = (l.height + totalPaddingTop + totalPaddingBottom - height).coerceAtLeast(0)
    // More of the note is still coming: wait until the line can be put at the top.
    if (wanted > max && !contentComplete) return false
    restoring = null
    reveal.hold(selectionEnd) // the caret stays where it is, off screen
    scroll.stop()
    scrollTo(scrollX, wanted.coerceIn(0, max))
    pinned = anchor
    postDelayed(unpin, TextFirstEditText.PIN_MS)
    return true
}

/** The characters on screen, a screen's height of margin either side. */
internal fun TextFirstEditText.visibleChars(): IntRange? {
    val l = layout ?: return null
    val top = scrollY - totalPaddingTop
    val first = l.getLineForVertical(maxOf(0, top - height))
    val last = l.getLineForVertical(top + 2 * height)
    return l.getLineStart(first)..l.getLineEnd(last)
}
