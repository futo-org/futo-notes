package com.futo.notes.textfirst

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Where a progressive open cuts the note: only where no block can straddle the cut. */
class OpenSlicesTest {
    private fun sb(text: String) = StringBuilder(text)

    @Test fun aShortNoteIsOneSlice() {
        val text = sb("one\n\ntwo\n")
        assertEquals(text.length, OpenSlices.sliceEnd(text, 0, 100))
    }

    @Test fun cutsAfterTheLineBeforeTheFirstBlankLinePastTheTarget() {
        val text = sb("aaaa\nbbbb\n\ncccc\n\ndddd\n")
        // Target 6 falls inside "bbbb"; the cut is where the blank line starts, so "bbbb\n" stays whole.
        val end = OpenSlices.sliceEnd(text, 0, 6)
        assertEquals("aaaa\nbbbb\n", text.substring(0, end))
        // The next slice starts on the blank line and finds the following one.
        val next = OpenSlices.sliceEnd(text, end, 3)
        assertEquals("\ncccc\n", text.substring(end, next))
    }

    @Test fun neverCutsInsideATable() {
        val table = "| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n"
        val text = sb("intro\n\n$table\nafter\n")
        val end = OpenSlices.sliceEnd(text, 0, 14) // target lands in the table's second line
        assertEquals("intro\n\n$table", text.substring(0, end))
    }

    @Test fun aNoteWithNoBlankLineKeepsWholeLines() {
        val text = sb((1..2000).joinToString("\n") { "line $it" } + "\n")
        val end = OpenSlices.sliceEnd(text, 0, 100)
        assertTrue(end >= 100)
        assertEquals('\n', text[end - 1])
    }

    @Test fun slicesCoverTheNoteExactlyOnce() {
        val text = sb((0 until 5000).joinToString("") { "# h$it\n\npara $it\n\n- a\n- b\n\n" })
        var at = 0
        var slices = 0
        while (at < text.length) {
            val end = OpenSlices.sliceEnd(text, at, OpenSlices.NEXT_CHARS)
            assertTrue("progress", end > at)
            at = end
            slices += 1
        }
        assertEquals(text.length, at)
        assertTrue("it took several slices: $slices", slices > 3)
    }
}
