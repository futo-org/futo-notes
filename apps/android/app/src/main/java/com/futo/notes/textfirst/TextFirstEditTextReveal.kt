package com.futo.notes.textfirst

/**
 * Reveal the caret now, whatever layout is pending.
 *
 * TextView reveals the caret in a pre-draw, but while a layout is pending it only remembers
 * the offset for onLayout, where the pending layout still reads as pending and the reveal is
 * deferred again. Any key that grows the note (Enter, a wrapped line) has a layout pending,
 * and Compose's AndroidView runs it during the draw, after the pre-draw: the reveal then
 * waited for whatever next registered a pre-draw (the cursor blink, up to 500 ms later), the
 * caret sitting off screen or cut by the bottom edge meanwhile. The text layout is current by
 * the time a key lands, so reveal against it at once. The view's size is the only thing a
 * pending layout can still change: [TextFirstEditText.onSizeChanged] reveals again.
 */
internal inline fun TextFirstEditText.revealNow(reveal: () -> Boolean): Boolean {
    revealing = true
    try { return reveal() } finally { revealing = false }
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
