package com.futo.notes.ui

import androidx.compose.ui.text.TextRange
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
    private val focused = TitleFieldState("Untitled").apply {
        focusChanged(true)
        typed("jkl ", TextRange(4))
    }

    private fun TitleFieldState.typed(text: String, selection: TextRange) =
        textState.edit { replace(0, length, text); this.selection = selection }

    @Test
    fun `a title committed while the field is focused leaves what the user typed`() {
        focused.commit("jkl")

        assertEquals("jkl ", focused.text)
        assertEquals(TextRange(4), focused.textState.selection)
    }

    @Test
    fun `the committed title shows once the field loses focus, caret at its end`() {
        focused.commit("jkl")
        focused.focusChanged(false)

        assertEquals("jkl", focused.text)
        assertEquals(TextRange(3), focused.textState.selection)
    }

    @Test
    fun `typing after a commit wins over the committed title`() {
        focused.commit("jkl")
        focused.typed("jkl m", TextRange(5))
        focused.focusChanged(false)

        assertEquals("jkl m", focused.text)
    }

    @Test
    fun `moving the caret is not typing`() {
        focused.commit("jkl")
        focused.textState.edit { selection = TextRange(1) }
        focused.focusChanged(false)

        assertEquals("jkl", focused.text)
    }

    @Test
    fun `a title committed while the field is not focused shows at once`() {
        val renamed = TitleFieldState("Note").apply { commit("Note-2") }

        assertEquals("Note-2", renamed.text)
        assertEquals(TextRange(6), renamed.textState.selection)
    }
}
