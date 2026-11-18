package com.futo.notes.textfirst

import org.junit.Assert.assertEquals
import org.junit.Test

/** !300's selection rule near code (cb 110-130, 880-893), over a block whose code is display 10..30. */
class CodeSelectionTest {
    private val block = CodeRange(10, 30)
    private val empty = CodeRange(40, 40)

    @Test fun aDragAnchoredInCodeStopsAtTheCodesEdges() {
        assertEquals(10 to 15, resolveCodeSelection(15, 2, listOf(block)))
        assertEquals(15 to 30, resolveCodeSelection(15, 35, listOf(block)))
    }

    @Test fun aDragAnchoredOutsideTakesEveryBlockItReachesWhole() {
        assertEquals(2 to 30, resolveCodeSelection(2, 12, listOf(block)))
        assertEquals(10 to 35, resolveCodeSelection(35, 25, listOf(block)))
    }

    @Test fun aRangeThatOnlyMeetsABlockTakesNoneOfIt() {
        assertEquals(2 to 10, resolveCodeSelection(2, 10, listOf(block)))
        // From the line below, the range starts past the block's line break, never at its last code position (P166).
        assertEquals(31 to 35, resolveCodeSelection(35, 30, listOf(block)))
    }

    @Test fun anEmptyBlockHasNoInsideSoAPressThereTakesIt() {
        assertEquals(35 to 45, resolveCodeSelection(45, 35, listOf(empty)))
        assertEquals(40 to 44, resolveCodeSelection(40, 44, listOf(empty)))
    }

    @Test fun aPressAtTheCodesEdgeDraggedOutSelectsNothing() {
        assertEquals(10 to 10, resolveCodeSelection(10, 3, listOf(block)))
    }

    /** Mason (P166): a selection made from the line below a block never ends at the block's last code position. */
    @Test fun aSelectionFromTheLineBelowStartsPastTheBlocksBreak() {
        assertEquals(31 to 41, resolveCodeSelection(41, 30, listOf(block)))
    }
}
