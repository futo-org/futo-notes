package com.futo.notes.textfirst

import org.junit.Assert.*
import org.junit.Test

class RenderWorkTest {
    @Test fun anOverlayRevertShrinksTheBoundaryBeforeTheCanonicalDeltaIsChecked() {
        assertTrue(requiresPrefixReset(listOf(TextEdit(0, 100, ""), TextEdit(0, 6_020, "x")), 6_100))
    }
    @Test fun anOverlayRevertCanAlsoExpandThePrefixBeforeTheNextDelta() {
        assertFalse(requiresPrefixReset(listOf(TextEdit(0, 10, "X".repeat(100)), TextEdit(0, 6_050, "x")), 6_000))
    }
    @Test fun visibleDeltasAndUnseenDeltasRemainDistinct() {
        assertFalse(requiresPrefixReset(listOf(TextEdit(0, 100, ""), TextEdit(0, 5_900, "x")), 6_100))
        assertTrue(requiresPrefixReset(listOf(TextEdit(6_001, 6_001, "x")), 6_000))
    }
    @Test fun rawMarkedPrefixIsBoundedEvenWithoutLineBreaksAndDoesNotSplitEmoji() {
        assertEquals(6_000, rawPrefixEnd("X".repeat(20_000), 6_000))
        val text = "a".repeat(5_999) + "\uD83D\uDE00" + "tail"
        assertEquals(5_999, rawPrefixEnd(text, 6_000))
        assertEquals(6_001, rawPrefixEnd(text, 6_001))
    }
    @Test fun anEmptyMirrorDeltaDoesNotRequestAResetBeyondTheRenderedPrefix() {
        val mirror = DisplayMirror().apply { reset("X".repeat(20_000)) }
        val edits = mutableListOf<TextEdit>()
        mirror.replace(20_000, 20_000, "", edits)
        assertTrue("source/style revisions may contain no display-text mutation", edits.isEmpty())
        assertFalse(requiresPrefixReset(edits, 6_000))
        assertEquals(20_000, mirror.text.length)
    }
    @Test fun anEmptyDisplayDeltaAtTheNoteEndDoesNotBroadenAStyleWindow() {
        assertEquals(RendererChange(0, 6_000, 6_000), rendererChange(2_000_001,
            listOf(TextEdit(2_000_000, 2_000_000, "")), listOf(StyleWindow(0, 6_000, emptyList()))))
        assertNull(rendererChange(2_000_001, listOf(TextEdit(2_000_000, 2_000_000, "")), emptyList()))
    }
    @Test fun offPrefixStyleMetadataInvalidatesOnlyTheEditableThatExists() {
        assertEquals(RendererChange(0, 5, 5), rendererChange(5, emptyList(), listOf(StyleWindow(0, 10_000, emptyList()))))
    }
}
