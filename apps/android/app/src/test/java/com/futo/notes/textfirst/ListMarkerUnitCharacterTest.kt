package com.futo.notes.textfirst

import org.junit.Assert.assertEquals
import org.junit.Test

/** A list marker unit is stored as a no-break space, by position from the engine's marker spans, never by character. */
class ListMarkerUnitCharacterTest {
    private fun marker(at: Int) = SpanSpec.ListItemMarker(at, at + 1, 0, ListMarker.Bullet, "-", false)

    @Test fun onlyTheEnginesMarkerUnitsAreStoredAsNoBreakSpaces() {
        // A marker, an image (U+FFFC with no marker span), a typed no-break space, a second marker.
        val display = "\uFFFCone \uFFFC two\u00A0three\n\uFFFCfour"
        val specs = listOf(marker(0), SpanSpec.Image(5, 6, "a.png", "", true, false), marker(17))
        assertEquals(listOf(0, 17), listMarkerUnitPositions(display, specs))
        val stored = StringBuilder(display).apply { for (at in listMarkerUnitPositions(display, specs)) replace(at, at + 1, LIST_MARKER_UNIT_STORED) }
        assertEquals("one character for one: every offset is the engine's", display.length, stored.length)
        assertEquals("\u00A0one \uFFFC two\u00A0three\n\u00A0four", stored.toString())
    }

    @Test fun aMarkerAlreadyStoredOrOutsideTheTextIsLeftAlone() {
        assertEquals(emptyList<Int>(), listMarkerUnitPositions("\u00A0one", listOf(marker(0))))
        assertEquals(emptyList<Int>(), listMarkerUnitPositions("one", listOf(marker(5))))
    }
}
