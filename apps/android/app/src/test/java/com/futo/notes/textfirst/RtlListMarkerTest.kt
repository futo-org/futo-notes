package com.futo.notes.textfirst

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** A right-to-left list item (Hebrew, Arabic) keeps its marker beside its text, on the right. */
class RtlListMarkerTest {
    private val width = 700
    private val indent = 24f

    @Test fun markerSpanSitsInsideTheLeadingMarginInEitherDirection() {
        // Layout draws an LTR margin from x = 0 rightward and an RTL margin from x = width leftward.
        assertEquals(10f to 20f, leadingSpan(0, 1, 10f, 20f))
        assertEquals(680f to 690f, leadingSpan(width, -1, 10f, 20f))
        // Every point of the RTL marker is on the canvas, none past its left edge.
        assertTrue(leadingX(width, -1, indent * 0.45f) in 0f..width.toFloat())
    }

    @Test fun checkboxTapIsJudgedOnTheTextsLeadingSide() {
        // LTR: text starts at 24, the box is left of it.
        assertTrue(onTaskCheckbox(10f, contentEdge = indent, dir = 1, indent = indent, slop = 4f, reach = 8f))
        assertFalse(onTaskCheckbox(60f, contentEdge = indent, dir = 1, indent = indent, slop = 4f, reach = 8f))
        // RTL: text starts at 676 and the box is right of it; a tap at the left edge is not a toggle.
        val rtlEdge = width - indent
        assertTrue(onTaskCheckbox(690f, contentEdge = rtlEdge, dir = -1, indent = indent, slop = 4f, reach = 8f))
        assertFalse(onTaskCheckbox(10f, contentEdge = rtlEdge, dir = -1, indent = indent, slop = 4f, reach = 8f))
        assertFalse(onTaskCheckbox(600f, contentEdge = rtlEdge, dir = -1, indent = indent, slop = 4f, reach = 8f))
    }
}
