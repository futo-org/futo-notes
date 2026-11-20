package com.futo.notes.textfirst

import org.junit.Assert.assertEquals
import org.junit.Test

/** A list item's text starts after its marker unit; the keyboard judges its caps from the line's start. */
class ImeCapsModeTest {
    @Test fun anItemsTextStartIsJudgedFromItsLineStart() {
        assertEquals(0, capsOffset("\uFFFCa", 1))
        assertEquals(4, capsOffset("one\n\uFFFCtwo", 5))
    }

    @Test fun anythingElseIsJudgedWhereTheCaretIs() {
        assertEquals(3, capsOffset("ab\uFFFC", 3))
        assertEquals(5, capsOffset("\uFFFCtwo ", 5))
        assertEquals(0, capsOffset("", 0))
        assertEquals(2, capsOffset("ab", 5))
    }
}
