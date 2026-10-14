package com.futo.notes.ui

import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * A forbidden char is stripped in place as it's typed [list.md]. The caret
 * used to stay where the stripped char had pushed it, one place too far right,
 * so "/X:Y" typed between "abc" and "de" came out "abcdXeY".
 */
class TitleInputFilterTest {
    /** Types [keys] one at a time, as the field would, filtering after each. */
    private fun TextFieldValue.typed(keys: String) = keys.fold(this) { v, key ->
        val at = v.selection.min
        val edited = v.text.substring(0, at) + key + v.text.substring(v.selection.max)
        filteredTitleInput(TextFieldValue(edited, TextRange(at + 1)))
    }

    @Test
    fun `a forbidden char typed mid-title leaves the caret where it was typed`() {
        val typed = TextFieldValue("abcde", TextRange(3)).typed("/X:Y")

        assertEquals(TextFieldValue("abcXYde", TextRange(5)), typed)
    }

    @Test
    fun `a selection keeps its place among the surviving chars`() {
        val filtered = filteredTitleInput(TextFieldValue("a/bc:d", TextRange(2, 5)))

        assertEquals(TextFieldValue("abcd", TextRange(1, 3)), filtered)
    }

    @Test
    fun `a paste trimmed to the length cap puts the caret after what survived of it`() {
        val pasted = "a/xy/z" + "a".repeat(TitleSpec.maxLength - 3)
        val filtered = filteredTitleInput(TextFieldValue(pasted, TextRange(6)))

        assertEquals(TextFieldValue("axyz" + "a".repeat(TitleSpec.maxLength - 4), TextRange(4)), filtered)
    }
}
