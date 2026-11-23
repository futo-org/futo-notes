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

    /** Gboard judges caps from the text before the caret, where the marker unit reads as mid-sentence. */
    @Test fun theKeyboardReadsTheMarkerUnitAsTheLineBreakBeforeIt() {
        val text = "one\n\uFFFCtwo"
        assertEquals("one\n\n", imeTextBefore(text, 5, 0, 10))
        assertEquals("\n", imeTextBefore(text, 5, 0, 1))
        assertEquals("\n", imeTextBefore("\uFFFCa", 1, 0, 5))
        assertEquals("one\n\n" + "two", ImeContextWindow.capture(text, 5, 5)!!.text)
    }

    @Test fun textBeforeAnythingElseIsReadAsItIs() {
        assertEquals("one\n", imeTextBefore("one\n\uFFFCtwo", 4, 0, 10))
        assertEquals("one\n\uFFFCtw", imeTextBefore("one\n\uFFFCtwo", 7, 0, 10))
        assertEquals("ab\uFFFC", imeTextBefore("ab\uFFFC", 3, 0, 10))
    }
}
