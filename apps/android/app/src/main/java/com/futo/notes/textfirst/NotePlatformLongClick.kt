package com.futo.notes.textfirst

/**
 * The platform's long press on the note, once no block lifts: a code block or an image takes it as one object, else the
 * TextView's own [platform] long press selects. A held list marker is selected first: the platform's long press keeps
 * that selection and opens its menu on it.
 */
internal fun TextFirstEditText.notePlatformLongClick(platform: () -> Boolean): Boolean {
    renderHold.longPressed()
    if (codeTouch.longPress() || imageTouch.longPress() || holdInsideSelectionWithItsMenu()) return true
    endSelectionUnderHold()
    listMarkerTouch.longPress()
    return platform()
}
