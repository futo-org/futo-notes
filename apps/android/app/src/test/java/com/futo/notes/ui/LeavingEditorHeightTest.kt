package com.futo.notes.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Leaving a note with the keyboard up used to resize the editor WebView on
 * every frame of the keyboard's exit animation, each one a layout of the whole
 * note, while the note list was drawing its first frames.
 */
class LeavingEditorHeightTest {
    @Test
    fun `a leaving editor keeps its last settled height`() {
        assertEquals(1840, leavingEditorHeight(interactionLocked = true, settledHeightPx = 1840))
    }

    @Test
    fun `an editor that is not leaving follows its box`() {
        assertNull(leavingEditorHeight(interactionLocked = false, settledHeightPx = 1840))
    }

    @Test
    fun `an editor that never laid out is not held at zero`() {
        assertNull(leavingEditorHeight(interactionLocked = true, settledHeightPx = 0))
    }
}
