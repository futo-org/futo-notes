package com.futo.notes.textfirst

import org.junit.Assert.*
import org.junit.Test
import uniffi.futo_notes_ffi.EditorBlockDescription
import uniffi.futo_notes_ffi.EditorByteRange
import uniffi.futo_notes_ffi.EditorListDescription
import uniffi.futo_notes_ffi.EditorProjection

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

    @Test fun emptyCodeFrameDrawsOneCodeBlock() {
        val p = projection("", listOf(block(0, 0), block(0, 0), block(0, 0)))
        val specs = planSpans(p, 0) { error("unexpected outside offset $it") }
        assertEquals(1, specs.filterIsInstance<SpanSpec.Code>().size)
        assertTrue(specs.none { it is SpanSpec.Quote || it is SpanSpec.ListRow || it is SpanSpec.Indent })
    }

    @Test fun listLinesTakeTheEngineLevelAndShowTheirMarkerAsTyped() {
        val text = "a\nb\nc\nd\ne"
        val p = projection(text, listOf(
            block(0, 1, code = false, list = list(indent = 0, level = 0, marker = "09.", ordered = true)),
            block(2, 3, code = false, list = list(indent = 2, level = 1, marker = "3)", ordered = true)),
            block(4, 5, code = false, list = list(indent = 0, level = 0, marker = "-", checked = true)),
            block(6, 7, code = false, list = list(indent = 4, level = 1, marker = "*")),
            block(8, 9, code = false, list = list(indent = 2, level = 1, marker = "")),
        ))
        val specs = planSpans(p, 0) { error("unexpected outside offset $it") }
        val rows = specs.filterIsInstance<SpanSpec.ListRow>()
        assertEquals(listOf("09.", "3)", "-", "*"), rows.map { it.label })
        assertEquals(listOf(ListMarker.Ordered, ListMarker.Ordered, ListMarker.Task, ListMarker.Bullet), rows.map { it.marker })
        assertEquals(listOf(0, 1, 0, 1), rows.map { it.depth })
        assertTrue(rows[2].checked)
        val plain = specs.filterIsInstance<SpanSpec.Indent>().single()
        assertEquals(8, plain.start)
        assertEquals(1, plain.depth)
    }

    private fun projection(text: String, blocks: List<EditorBlockDescription>) = EditorProjection(
        0uL, EditorByteRange(0uL, text.toByteArray(Charsets.UTF_8).size.toULong()), text,
        emptyList(), emptyList(), blocks, emptyList(), emptyList(), emptyList(),
    )

    private fun block(from: Int, to: Int, code: Boolean = true, list: EditorListDescription? = null) = EditorBlockDescription(
        EditorByteRange(from.toULong(), to.toULong()), 0u, 0uL, false, list, code, null, false,
    )

    private fun list(indent: Int, level: Int, marker: String, ordered: Boolean = false, checked: Boolean? = null) =
        EditorListDescription(indent.toULong(), level.toULong(), marker, ordered, checked, true)
}
