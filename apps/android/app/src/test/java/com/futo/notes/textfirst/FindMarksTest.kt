package com.futo.notes.textfirst

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class FindMarksTest {
    private fun snapshot(open: Boolean, current: Int, vararg m: Pair<Int, Int>) =
        FindSnapshot(open, "q", m.size, current, false, m.toList())

    private fun hits(marks: FindMarks, from: Int, to: Int) = buildList {
        marks.visit(from, to) { s, e, cur -> add(Triple(s, e, cur)) }
    }

    @Test fun visitsOnlyMatchesOverlappingTheWindowAndFlagsTheCurrentOne() {
        val marks = FindMarks().apply { set(snapshot(true, 2, 0 to 3, 10 to 13, 20 to 22, 30 to 33)) }
        assertEquals(listOf(Triple(10, 13, true), Triple(20, 22, false)), hits(marks, 12, 21))
        assertEquals(listOf(Triple(0, 3, false)), hits(marks, 0, 1))
        assertTrue(hits(marks, 3, 10).isEmpty())
    }

    @Test fun closedFindPaintsNothing() {
        val marks = FindMarks().apply { set(snapshot(true, 1, 0 to 3)) }
        marks.set(snapshot(false, 0, 0 to 3))
        assertTrue(marks.isEmpty)
        assertTrue(hits(marks, 0, 100).isEmpty())
    }
}
