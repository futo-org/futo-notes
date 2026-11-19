package com.futo.notes.textfirst

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The reflow preview's geometry (#450): where the gap goes as the finger moves, and where each
 * part of the note is drawn for a gap. Content y in px.
 */
class BlockReflowTest {
    // Lines 0-40, 40-70, 70-100, the block 100-140, then 140-180, 180-220, 220-300; the end at 300.
    private val block = ReflowShape(top = 100f, bottom = 140f, residue = 0f, copy = 40f)
    private fun lines(vararg slots: Float) = ReflowStops(block, slots.toList(), photo = false)
    private val all = lines(0f, 40f, 70f, 180f, 220f, 300f)

    @Test
    fun theGapPassesANeighbourWhenTheFingerPassesItsMiddleAsDrawnNow() {
        val home = all.home
        assertEquals(3, home)
        assertEquals("over its own place nothing moves", home, all.walk(home, 150f))
        // The line below (140-180) has its middle at 160.
        val below = all.walk(home, 165f)
        assertEquals(4, below)
        assertEquals(ReflowGap.At(180f, below = true), all.gap(below))
        // That line is now drawn where the block was (100-140): back up past 120, not 160.
        assertEquals("no flicker between the two middles", below, all.walk(below, 125f))
        assertEquals(home, all.walk(below, 115f))
        // Up past the middle of the line above (70-100).
        assertEquals(2, all.walk(home, 84f))
        assertEquals(ReflowGap.At(70f, below = false), all.gap(2))
        assertEquals("a fast finger passes several at once", 6, all.walk(home, 2_000f))
        assertEquals(0, all.walk(home, -50f))
    }

    @Test
    fun whereNoSlotIsOfferedTheFingerPassesTheWholeRunToTheNextOne() {
        // No slot at 220 (inside a quote): 180-300 is one run, its middle 240.
        val quote = lines(0f, 40f, 70f, 180f, 300f)
        val at180 = quote.walk(quote.home, 165f)
        assertEquals(ReflowGap.At(180f, true), quote.gap(at180))
        assertEquals(at180, quote.walk(at180, 235f))
        assertEquals(ReflowGap.At(300f, true), quote.gap(quote.walk(at180, 245f)))
    }

    @Test
    fun theSourceClosesAndTheGapOpensWithACopyInIt() {
        val below = ReflowGap.At(220f, below = true)
        assertEquals("above the block nothing moves", 0f, block.shift(70f, below))
        assertEquals("between the block and the gap, up by the block", -40f, block.shift(140f, below))
        assertEquals(-40f, block.shift(180f, below))
        assertEquals("past the gap, where it was", 0f, block.shift(220f, below))
        assertEquals(180f, block.copyTop(below))
        val above = ReflowGap.At(40f, below = false)
        assertEquals(0f, block.shift(0f, above))
        assertEquals("between the gap and the block, down by the block", 40f, block.shift(40f, above))
        assertEquals(40f, block.shift(70f, above))
        assertEquals(0f, block.shift(140f, above))
        assertEquals(40f, block.copyTop(above))
        assertEquals(0f, block.shift(180f, ReflowGap.Home))
        assertEquals(100f, block.copyTop(ReflowGap.Home))
    }

    /** A block whose copy is not as tall as its place closes (a photo leaving its line): what follows the gap moves by the difference. */
    @Test
    fun aPhotoLeavingItsLineLeavesTheLineWithoutItAndOpensAGapAsTallAsItsOwnLine() {
        // "Nice!" and a 300 px photo on one line (100-400); without the photo the line is 40 px, the photo alone 304.
        val photo = ReflowShape(top = 100f, bottom = 400f, residue = 40f, copy = 304f)
        val stops = ReflowStops(photo, listOf(40f, 100f, 400f, 440f), photo = true)
        val home = stops.home
        assertEquals(2, home)
        assertEquals("held on the photo nothing moves", home, stops.walk(home, 200f))
        assertEquals(home, stops.walk(home, 300f))
        val above = stops.walk(home, 160f)
        assertEquals(ReflowGap.At(100f, below = false), stops.gap(above))
        assertEquals(100f, photo.copyTop(stops.gap(above)))
        assertEquals("the line without it under the copy", 404f, photo.residueTop(stops.gap(above)))
        assertEquals("what follows moves by the difference", 44f, photo.shift(400f, stops.gap(above)))
        assertEquals(above, stops.walk(above, 160f))
        val below = stops.walk(home, 380f)
        assertEquals(ReflowGap.At(400f, below = true), stops.gap(below))
        assertEquals(100f, photo.residueTop(stops.gap(below)))
        assertEquals("the copy under the line without it", 140f, photo.copyTop(stops.gap(below)))
        assertEquals(44f, photo.shift(440f, stops.gap(below)))
        // Back up over the line without it (drawn 100-140): past its lower quarter it comes home, then above.
        assertEquals(below, stops.walk(below, 135f))
        assertEquals(ReflowGap.At(100f, below = false), stops.gap(stops.walk(below, 110f)))
    }

    @Test
    fun aMoveMapsEachParagraphOfTheStretchToWhereItLands() {
        // Whole lines, two of them, dropped below three: old [B B M M M] becomes [M M M B B].
        val down = ReflowMove(photo = false, below = true, block = 2, between = 3)
        assertEquals(listOf(3, 4, 0, 1, 2, 5, 6), (0..6).map(down::lands))
        assertEquals(3, down.moved)
        // Dropped above: old [M M M B B] becomes [B B M M M].
        val up = ReflowMove(photo = false, below = false, block = 2, between = 3)
        assertEquals(listOf(2, 3, 4, 0, 1, 5), (0..5).map(up::lands))
        assertEquals(0, up.moved)
        // A photo leaving its line below two lines: [R M M] becomes [R M M P]; everything after one later.
        val photoDown = ReflowMove(photo = true, below = true, block = 1, between = 2)
        assertEquals(listOf(0, 1, 2, 4), (0..3).map(photoDown::lands))
        assertEquals(3, photoDown.moved)
        // Above two lines: [M M R] becomes [P M M R].
        val photoUp = ReflowMove(photo = true, below = false, block = 1, between = 2)
        assertEquals(listOf(1, 2, 3, 4), (0..3).map(photoUp::lands))
        assertEquals(0, photoUp.moved)
    }
}
