package com.futo.notes.textfirst

/**
 * A hold with the keyboard up selects the word under it, whatever selection stood (round 3, N2). The platform keeps a
 * standing selection and reopens its handles and menu instead; after a text change that left one (an Undo restoring
 * it, Bold on a held word) it had hidden them, so the hold seemed to bring back an old range. Called just before the
 * platform's long press on a touch outside the selection: the selection ends at the press, and the platform then
 * selects the word there.
 */
internal fun TextFirstEditText.endSelectionUnderHold() {
    // An accessibility long click has no press, and no position of its own: the selection is left to the platform.
    if (!isFocused || !isPressed || selectionStart == selectionEnd) return
    val at = getOffsetForPosition(scroll.downX, scroll.downY)
    // A hold inside the selection is the platform's: it drags the selected text or opens its menu.
    if (at in minOf(selectionStart, selectionEnd)..maxOf(selectionStart, selectionEnd)) return
    renderHold.closeTextMenus()
    setSelection(at)
}

/**
 * A hold inside a selection whose menu is open lifts nothing (round 5): the platform would start a text drag, and its
 * drop cannot be made here (the engine's one-step move is not offered to this editor). True when the hold is that one,
 * handled by leaving the selection and its menu as they stand.
 */
internal fun TextFirstEditText.holdInsideSelectionWithItsMenu(): Boolean {
    if (!isFocused || !isPressed || selectionStart == selectionEnd || !renderHold.hasOpenTextMenu) return false
    val at = getOffsetForPosition(scroll.downX, scroll.downY)
    // Strictly inside: a hold at the selection's edge is on what lies beside it (a list marker, the next word).
    if (at <= minOf(selectionStart, selectionEnd) || at >= maxOf(selectionStart, selectionEnd)) return false
    // The lift that ends the hold is not a tap: the platform would put the caret there (TextFirstEditTextTouch).
    heldInsideSelection = true
    return true
}
