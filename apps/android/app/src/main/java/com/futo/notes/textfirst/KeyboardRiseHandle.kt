package com.futo.notes.textfirst

import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsAnimationCompat
import androidx.core.view.WindowInsetsCompat

/**
 * As the keyboard starts to rise, hide the handle of a caret whose foot the risen keyboard will cover (a caret beside a
 * tall photo), before the first frame of the rise: hidden only once the note shrank, it showed over the rising keyboard
 * for a few frames (round 4). The keyboard's end height is known when its animation starts.
 */
internal fun TextFirstEditText.hideCaretHandleAsKeyboardRises() {
    ViewCompat.setWindowInsetsAnimationCallback(this, object : WindowInsetsAnimationCompat.Callback(DISPATCH_MODE_CONTINUE_ON_SUBTREE) {
        override fun onStart(animation: WindowInsetsAnimationCompat, bounds: WindowInsetsAnimationCompat.BoundsCompat): WindowInsetsAnimationCompat.BoundsCompat {
            val rising = animation.typeMask and WindowInsetsCompat.Type.ime() != 0 &&
                ViewCompat.getRootWindowInsets(this@hideCaretHandleAsKeyboardRises)?.isVisible(WindowInsetsCompat.Type.ime()) == true
            if (rising) {
                val inWindow = IntArray(2).also(::getLocationInWindow)
                hideCaretHandleBelow(rootView.height - bounds.upperBound.bottom - inWindow[1] - totalPaddingBottom)
            }
            return bounds
        }

        override fun onProgress(insets: WindowInsetsCompat, running: MutableList<WindowInsetsAnimationCompat>): WindowInsetsCompat = insets
    })
}
