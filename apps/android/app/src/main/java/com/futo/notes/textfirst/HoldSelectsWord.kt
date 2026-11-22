package com.futo.notes.textfirst

/**
 * A hold with the keyboard up selects the word under it, whatever selection stood (round 3, N2). The platform keeps a
 * standing selection and reopens its handles and menu instead; after a text change that left one (an Undo restoring
 * it, Bold on a held word) it had hidden them, so the hold seemed to bring back an old range. Called just before the
 * platform's long press: the selection ends at the press, and the platform then selects the word there.
 */
internal fun TextFirstEditText.endSelectionUnderHold() {
    if (!isFocused || selectionStart == selectionEnd) return
    renderHold.closeTextMenus()
    setSelection(getOffsetForPosition(scroll.downX, scroll.downY))
}
