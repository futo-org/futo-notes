package com.futo.notes.textfirst

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertFalse
import org.junit.Test

/**
 * Sol (round 4): hiding the caret's handle under a rising keyboard turns the caret off and on, and turned on a caret
 * the editor had hidden (an empty code block selected as one object hides it).
 */
class TextFirstCaretHandleKeyboardTest {
    @Test fun aCaretTheEditorHidIsNotShownWhenTheKeyboardRises() = textFirstSession((1..60).joinToString("\n\n") { "line $it" }) { c ->
        val view = c.view
        withContext(Dispatchers.Main) { view.isFocusableInTouchMode = true; view.requestFocus() }
        withTimeout(5_000) { while (withContext(Dispatchers.Main) { view.layout == null }) delay(20) }
        val at = withContext(Dispatchers.Main) { view.editableText.indexOf("line 50") }
        c.select(at)
        withTimeout(5_000) { while (withContext(Dispatchers.Main) { view.selectionStart != at }) delay(20) }
        delay(300)
        withContext(Dispatchers.Main) {
            view.isCursorVisible = false
            // The reader scrolled to the top, the caret below the screen; the keyboard rises.
            view.scrollTo(0, 0)
            val params = view.layoutParams
            params.height = view.height / 2
            view.layoutParams = params
        }
        delay(500)
        check(withContext(Dispatchers.Main) { view.isFocused }) { "the note has focus" }
        assertFalse("the caret the editor hid stays hidden", withContext(Dispatchers.Main) { view.isCursorVisible })
    }
}
