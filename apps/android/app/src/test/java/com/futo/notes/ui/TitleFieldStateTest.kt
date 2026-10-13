package com.futo.notes.ui

import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The debounced rename lands 500 ms after the last keystroke, often while the
 * title is still being typed. Rewriting the field then moved the caret: a title
 * the rename trimmed ("jkl " → "jkl") lost its space, so "jkl ", a pause, then
 * "mno" came out "jklmno"; before that, the caret went to 0 and "abc", a pause,
 * "def" came out "defabc".
 */
class TitleFieldStateTest {
    private val typing = TextFieldValue("jkl ", selection = TextRange(4), composition = TextRange(0, 3))
    private val focused = TitleFieldState(TextFieldValue("Untitled")).afterFocusChange(true).afterTyping(typing)

    @Test
    fun `a title committed while the field is focused leaves what the user typed`() {
        assertEquals(typing, focused.afterCommit("jkl").value)
    }

    @Test
    fun `the committed title shows once the field loses focus, caret at its end`() {
        val blurred = focused.afterCommit("jkl").afterFocusChange(false)

        assertEquals(TextFieldValue("jkl", selection = TextRange(3)), blurred.value)
    }

    @Test
    fun `typing after a commit wins over the committed title`() {
        val kept = focused.afterCommit("jkl")
            .afterTyping(TextFieldValue("jkl m", selection = TextRange(5)))
            .afterFocusChange(false)

        assertEquals("jkl m", kept.value.text)
    }

    @Test
    fun `moving the caret is not typing`() {
        val blurred = focused.afterCommit("jkl")
            .afterTyping(typing.copy(selection = TextRange(1)))
            .afterFocusChange(false)

        assertEquals("jkl", blurred.value.text)
    }

    @Test
    fun `a title committed while the field is not focused shows at once`() {
        val renamed = TitleFieldState(TextFieldValue("Note")).afterCommit("Note-2")

        assertEquals(TextFieldValue("Note-2", selection = TextRange(6)), renamed.value)
    }
}
