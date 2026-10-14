package com.futo.notes.ui

import androidx.compose.foundation.text.input.TextFieldState
import androidx.compose.ui.text.TextRange
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * A forbidden char is stripped in place as it's typed [list.md]. The caret
 * used to stay where the stripped char had pushed it, one place too far right,
 * so "/X:Y" typed between "abc" and "de" came out "abcdXeY".
 */
class TitleInputFilterTest {
    /** Applies one edit the way the field does: the edit, then the title filter. */
    private fun TextFieldState.input(text: String, at: TextRange, selectionAfter: TextRange) = edit {
        replace(at.min, at.max, text)
        selection = selectionAfter
        filterTitleInput()
    }

    /** Types [keys] one at a time at the caret. */
    private fun TextFieldState.typed(keys: String) = keys.forEach { key ->
        input(key.toString(), selection, TextRange(selection.min + 1))
    }

    @Test
    fun `a forbidden char typed mid-title leaves the caret where it was typed`() {
        val title = TextFieldState("abcde", TextRange(3)).apply { typed("/X:Y") }

        assertEquals("abcXYde", title.text.toString())
        assertEquals(TextRange(5), title.selection)
    }

    @Test
    fun `a selection keeps its place among the surviving chars`() {
        val title = TextFieldState("ad").apply { input("/bc:", TextRange(1), TextRange(2, 5)) }

        assertEquals("abcd", title.text.toString())
        assertEquals(TextRange(1, 3), title.selection)
    }

    @Test
    fun `a paste trimmed to the length cap puts the caret after what survived of it`() {
        val title = TextFieldState("a" + "a".repeat(TitleSpec.maxLength - 3)).apply {
            input("/xy/z", TextRange(1), TextRange(6))
        }

        assertEquals("axyz" + "a".repeat(TitleSpec.maxLength - 4), title.text.toString())
        assertEquals(TextRange(4), title.selection)
    }
}
