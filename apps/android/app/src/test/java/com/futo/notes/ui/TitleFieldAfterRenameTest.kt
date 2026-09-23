package com.futo.notes.ui

import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The debounced rename lands 500 ms after the last keystroke, often while the
 * title is still being typed. It used to rebuild the field from the committed
 * title with the caret at 0, so "abc", a pause, then "def" came out "defabc".
 */
class TitleFieldAfterRenameTest {
    @Test
    fun `a rename that keeps the typed title leaves the caret where it was`() {
        val typing = TextFieldValue("abc", selection = TextRange(3), composition = TextRange(0, 3))

        assertEquals(typing, titleFieldAfterRename(typing, "abc"))
    }

    @Test
    fun `a rename that changed the title puts the caret at its end`() {
        val typed = TextFieldValue("Groceries ", selection = TextRange(10))

        assertEquals(
            TextFieldValue("Groceries", selection = TextRange(9)),
            titleFieldAfterRename(typed, "Groceries"),
        )
    }
}
