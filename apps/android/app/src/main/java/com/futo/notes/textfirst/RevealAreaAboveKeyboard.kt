package com.futo.notes.textfirst

import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import kotlin.math.roundToInt

/**
 * Scrolls the note just enough to show [top] to [bottom] (layout coordinates) above the keyboard; an area already in
 * view never moves the note. An area taller than the space keeps its top. True when the note moved.
 */
internal fun TextFirstEditText.revealAreaAboveKeyboard(top: Float, bottom: Float): Boolean {
    val visibleBottom = visibleBottomAboveKeyboard()
    val onScreenTop = totalPaddingTop - scrollY + top
    val onScreenBottom = totalPaddingTop - scrollY + bottom
    val shift = when {
        onScreenTop < totalPaddingTop -> onScreenTop - totalPaddingTop
        onScreenBottom > visibleBottom -> minOf(onScreenBottom - visibleBottom, onScreenTop - totalPaddingTop)
        else -> return false
    }
    // Never past the note's end: the next restyle would pull it back while the reader types.
    scrollTo(scrollX, (scrollY + shift).roundToInt().coerceIn(0, maxScrollY()))
    return true
}

/** The bottom of the note's text area left visible by the keyboard, in view coordinates. */
internal fun TextFirstEditText.visibleBottomAboveKeyboard(): Int {
    // The keyboard resizes the note (the screen's imePadding) a few frames after it reports its height: measure
    // against the keyboard's own top, so the first reveal lands where the note will end and the resize moves nothing.
    val keyboard = ViewCompat.getRootWindowInsets(this)?.takeIf { it.isVisible(WindowInsetsCompat.Type.ime()) }
        ?.getInsets(WindowInsetsCompat.Type.ime())?.bottom
    val inWindow = IntArray(2).also(::getLocationInWindow)
    val keyboardTop = keyboard?.let { rootView.height - it - inWindow[1] } ?: height
    return minOf(height, keyboardTop) - totalPaddingBottom
}
