package com.futo.notes

import com.futo.notes.ui.components.imeJustHid
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Regression for #24: the system back gesture/button hides the soft keyboard
 * WITHOUT dropping focus, so a functionless caret kept blinking on screen.
 * The app must drop focus (and blur the editor WebView, whose DOM caret
 * survives a view-level clearFocus) exactly on the IME visible→hidden
 * transition — `imeJustHid`, driving the app-root + per-dialog
 * ClearFocusOnImeDismiss — and only then.
 */
class EditorImeDismissBlurTest {
    @Test
    fun firesOnlyOnVisibleToHiddenTransition() {
        assertTrue(imeJustHid(wasImeVisible = true, imeVisible = false))
        assertFalse(imeJustHid(wasImeVisible = false, imeVisible = true))
        assertFalse(imeJustHid(wasImeVisible = false, imeVisible = false))
        assertFalse(imeJustHid(wasImeVisible = true, imeVisible = true))
    }
}
