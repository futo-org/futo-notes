package com.futo.notes.textfirst

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** The drop line's choice of slot, the slot book's asks as the note scrolls, and the edge autoscroll. */
class BlockDragTargetsTest {
    private fun slot(offset: Int, end: Boolean = false) = BlockSlot(offset, end)

    @Test
    fun theDropLineIsTheNearestSlotUnlessTheBlocksOwnEdgeIsNearer() {
        // A block drawn from y 100 to 140; slots at 40, 180 and 220.
        val targets = DropTargets(listOf(slot(0) to 40f, slot(9) to 180f, slot(14) to 220f), own = 100f to 140f)
        assertEquals(slot(0), targets.nearest(50f)?.first)
        assertEquals(slot(9), targets.nearest(170f)?.first)
        assertEquals(slot(14), targets.nearest(500f)?.first)
        assertNull("over its own top edge it drops nowhere", targets.nearest(90f))
        assertNull("over its own bottom edge it drops nowhere", targets.nearest(150f))
        // A photo lifted alone has its middle for both edges; with no part of the block showing
        // (scrolled away) any slot is a drop.
        assertNull(DropTargets(listOf(slot(0) to 40f), own = 120f to 120f).nearest(110f))
        assertEquals(slot(0), DropTargets(listOf(slot(0) to 40f), own = null).nearest(400f)?.first)
        assertNull(DropTargets(emptyList(), own = null).nearest(10f))
    }

    @Test
    fun anEmptyLastTaskHasTwoSlotsAtOneOffset() {
        val book = SlotBook()
        book.add(listOf(slot(4, end = true), slot(4), slot(2)), covering = 0..4)
        assertEquals(listOf(slot(2), slot(4), slot(4, end = true)), book.slotsIn(0..4))
        assertEquals(listOf(slot(4), slot(4, end = true)), book.slotsIn(4..4))
    }

    @Test
    fun theBookAsksOnlyForTheStretchThatNewlyComesNearTheScreen() {
        val book = SlotBook()
        assertEquals(listOf(100..200) to 100..200, book.missing(100..200))
        book.add(listOf(slot(120), slot(180)), 100..200)
        // Scrolled down: only below what is covered; scrolled both ways at once: both sides.
        assertEquals(listOf(200..260) to 100..260, book.missing(150..260))
        assertEquals(listOf(40..100, 200..300) to 40..300, book.missing(40..300))
        assertEquals(emptyList<IntRange>() to 100..200, book.missing(110..190))
        // A jump past what was covered asks for the gap too, so the book stays one piece.
        assertEquals(listOf(200..900) to 100..900, book.missing(800..900))
        book.add(listOf(slot(200), slot(850)), 100..900)
        assertEquals(listOf(slot(120), slot(180), slot(200)), book.slotsIn(100..200))
    }

    @Test
    fun theEdgeZoneRampsFromTheInnerLipToTheEdge() {
        // A 1000 px view at density 2: the zones are 128 px.
        val d = 2f
        assertEquals(0f, BlockAutoscroll.velocity(500f, 0f, 1000f, d), 0f)
        assertEquals(0f, BlockAutoscroll.velocity(128f, 0f, 1000f, d), 0f)
        assertEquals(-400f, BlockAutoscroll.velocity(127.999f, 0f, 1000f, d), 0.1f)
        assertEquals(-1600f, BlockAutoscroll.velocity(64f, 0f, 1000f, d), 0.1f)
        assertEquals(-2800f, BlockAutoscroll.velocity(0f, 0f, 1000f, d), 0.1f)
        assertEquals("past the edge it stays at the fastest", 2800f, BlockAutoscroll.velocity(1200f, 0f, 1000f, d), 0.1f)
        assertEquals(1600f, BlockAutoscroll.velocity(936f, 0f, 1000f, d), 0.1f)
        // Shorter than two zones: the nearer edge wins.
        assertEquals(-1600f, BlockAutoscroll.velocity(64f, 0f, 200f, d), 0.1f)
        assertEquals(2200f, BlockAutoscroll.velocity(168f, 0f, 200f, d), 0.1f)
        // A frame's step is at most 0.05 s of travel.
        assertEquals(28f, BlockAutoscroll.step(2800f, 0.01f), 0.001f)
        assertEquals(140f, BlockAutoscroll.step(2800f, 0.5f), 0.001f)
        assertEquals(0f, BlockAutoscroll.step(2800f, -1f), 0f)
    }
}
