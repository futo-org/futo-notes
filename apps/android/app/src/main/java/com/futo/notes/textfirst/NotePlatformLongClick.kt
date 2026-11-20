package com.futo.notes.textfirst

/**
 * The platform's long press on the note, once no block lifts: a code block or an image takes it as one object, else the
 * TextView's own [platform] long press selects.
 */
internal fun TextFirstEditText.notePlatformLongClick(platform: () -> Boolean): Boolean {
    renderHold.longPressed()
    return codeTouch.longPress() || imageTouch.longPress() || platform()
}
