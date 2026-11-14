package com.futo.notes.textfirst

import org.junit.Assert.*
import org.junit.Test

class EngineImeStateTest {
    @Test fun giantSelectionHasNoContextAndNeverCopiesItsContents() {
        val text = object : CharSequence {
            override val length = 2_380_000
            override fun get(index: Int): Char = error("giant selection should not be read")
            override fun subSequence(startIndex: Int, endIndex: Int): CharSequence = error("giant selection should not be copied")
        }
        val state = EngineImeState.capture(text, 0, text.length, -1, -1, 0)
        assertEquals(text.length, state.selectionEnd)
        assertNull(state.context)
    }

    @Test fun windowKeepsGlobalOffsetsAndCompleteSmallSelection() {
        val text = "a".repeat(10_000)
        val window = ImeContextWindow.capture(text, 5_000, 5_020, before = Int.MAX_VALUE, after = Int.MAX_VALUE)!!
        assertEquals(5_000 - IME_CONTEXT_CHARS, window.start)
        assertEquals(IME_CONTEXT_CHARS, window.selectionStart)
        assertEquals(IME_CONTEXT_CHARS + 20, window.selectionEnd)
        assertEquals(IME_CONTEXT_CHARS * 2 + 20, window.text.length)
    }

    @Test fun cellContextOffsetsAreLocalToTheCell() {
        val window = ImeContextWindow.capture("prefix CELL suffix", 8, 10, low = 7, high = 11)!!
        assertEquals("CELL", window.text)
        assertEquals(0, window.start)
        assertEquals(1, window.selectionStart)
        assertEquals(3, window.selectionEnd)
    }

    @Test fun boundedContextDoesNotSplitSurrogatePairs() {
        val before = "x😀ab"
        assertEquals("ab", imeTextBefore(before, before.length, 0, 3))
        val after = "ab😀x"
        assertEquals("ab", imeTextAfter(after, 0, after.length, 3))
        val window = ImeContextWindow.capture("x😀abcd😀x", 5, 5, before = 3, after = 3)!!
        assertEquals("abcd", window.text)
        assertEquals(2, window.selectionStart)
    }

    @Test fun enormousBeforeAndAfterRequestsRemainBoundedEvenWithAWideSelection() {
        val text = "a".repeat(20_000)
        assertEquals(IME_CONTEXT_CHARS, imeTextBefore(text, 9_000, 0, Int.MAX_VALUE).length)
        assertEquals(IME_CONTEXT_CHARS, imeTextAfter(text, 11_000, text.length, Int.MAX_VALUE).length)
        assertNull(ImeContextWindow.capture(text, 9_000, 11_000))
    }
}
