package com.futo.notes.textfirst

import org.junit.Assert.*
import org.junit.Test

class ViewEditJournalTest {
    private fun opened() = ViewEditJournal().apply { discontinue(); record(1, emptyList()) }

    @Test fun aTapBehindAStyleOnlyCommandKeepsItsPosition() {
        // Select All + Bold off: the display text does not change, only the update number.
        val journal = opened().apply { record(2, emptyList()); record(3, emptyList()) }
        assertEquals(5 to 5, journal.map(1, 5, 5))
    }

    @Test fun aTapFollowsTheTextEditsItWasMadeBehind() {
        val journal = opened().apply { record(2, listOf(TextEdit(0, 0, "abc"))); record(3, listOf(TextEdit(10, 14, "x"))) }
        assertEquals(8 to 8, journal.map(1, 5, 5))
        assertEquals(15 to 15, journal.map(1, 15, 15))
        assertEquals("a view that saw update 2 only moves through update 3", 5 to 5, journal.map(2, 5, 5))
    }

    @Test fun aTapInsideReplacedTextStaysAsFarInAsTheNewTextReaches() {
        val journal = opened().apply { record(2, listOf(TextEdit(0, 100, "short"))) }
        assertEquals(3 to 5, journal.map(1, 3, 50))
    }

    @Test fun aViewOlderThanAWholeTextReloadCannotBeMapped() {
        val journal = opened().apply { discontinue(); record(2, emptyList()) }
        assertNull(journal.map(1, 5, 5))
        assertEquals(5 to 5, journal.map(2, 5, 5))
    }

    @Test fun aViewOlderThanTheRetainedEditsCannotBeMapped() {
        val journal = ViewEditJournal(capacity = 2).apply {
            discontinue(); record(1, emptyList())
            for (seq in 2..4) record(seq, listOf(TextEdit(0, 0, "a")))
        }
        assertNull(journal.map(1, 5, 5))
        assertEquals(7 to 7, journal.map(2, 5, 5))
    }
}
