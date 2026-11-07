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

    @Test fun hiddenCodeOpeningKeepsItsMarkerOnTheVisibleCodeRow() {
        for ((preceding, number) in listOf(null to null, 11L to 12L)) for (quote in 0..1) for (lead in listOf("a", "猫")) {
            val at = lead.toByteArray(Charsets.UTF_8).size + 1
            val p = projection("$lead\nr\nv", listOf(
                block(0, at - 1, first = true, code = false, number = preceding, quote = quote),
                block(at, at, first = true, number = number, quote = quote),
                block(at, at + 1, first = false, number = number, quote = quote),
                block(at + 1, at + 1, first = false, number = number, quote = quote),
                block(at + 2, at + 3, first = false, code = false, number = number, quote = quote),
            ))
            val specs = planSpans(p, 0) { error("unexpected outside offset $it") }
            val row = specs.filterIsInstance<SpanSpec.ListRow>().single { it.start == 2 }
            assertTrue("the canonical hidden opener owns the visible code row's marker", row.first)
            assertEquals(4, row.end)
            assertEquals(number, row.number)
            assertEquals(if (number == null) ListMarker.Bullet else ListMarker.Ordered, row.marker)
            assertEquals(1, specs.filterIsInstance<SpanSpec.Code>().size)
            assertEquals(if (quote == 0) 0 else 3, specs.filterIsInstance<SpanSpec.Quote>().size)
            assertEquals(2, specs.filterIsInstance<SpanSpec.ListRow>().count { it.first })
        }
    }

    @Test fun visibleTextFirstDoesNotRepeatItsMarkerOnTheCodeChild() {
        val p = projection("lead\nr", listOf(
            block(0, 4, first = true, code = false),
            block(5, 5, first = false),
            block(5, 6, first = false),
            block(6, 6, first = false),
        ))
        val specs = planSpans(p, 0) { error("unexpected outside offset $it") }
        val rows = specs.filterIsInstance<SpanSpec.ListRow>()
        assertEquals(listOf(0), rows.filter { it.first }.map { it.start })
        assertFalse(rows.single { it.start == 5 }.first)
        assertEquals(1, specs.filterIsInstance<SpanSpec.Code>().size)
    }

    @Test fun taskCodeChildKeepsItsStateWithoutRepeatingTheFirstLineMarker() {
        for (checked in listOf(false, true)) for (depth in 1..2) {
            val p = projection("lead\n猫", listOf(
                block(0, 4, first = true, code = false, checked = checked, depth = depth, quote = 1),
                block(5, 5, first = false, checked = checked, depth = depth, quote = 1),
                block(5, 8, first = false, checked = checked, depth = depth, quote = 1),
                block(8, 8, first = false, checked = checked, depth = depth, quote = 1),
            ))
            val specs = planSpans(p, 0) { error("unexpected outside offset $it") }
            val rows = specs.filterIsInstance<SpanSpec.ListRow>()
            assertEquals(listOf(0), rows.filter { it.first }.map { it.start })
            val row = rows.single { it.start == 5 }
            assertFalse(row.first)
            assertEquals(ListMarker.Task, row.marker)
            assertEquals(checked, row.checked)
            assertEquals(depth - 1, row.depth)
            assertEquals(6, row.end)
            assertEquals(1, specs.filterIsInstance<SpanSpec.Code>().size)
            assertEquals(2, specs.filterIsInstance<SpanSpec.Quote>().size)
        }
    }

    @Test fun emptyCodeFrameKeepsOneMarkerAndOneSetOfMargins() {
        for (quote in 0..1) {
            val p = projection("", listOf(
                block(0, 0, first = true, quote = quote),
                block(0, 0, first = false, quote = quote),
                block(0, 0, first = false, quote = quote),
            ))
            val specs = planSpans(p, 0) { error("unexpected outside offset $it") }
            assertEquals(1, specs.filterIsInstance<SpanSpec.Code>().size)
            assertEquals(quote, specs.filterIsInstance<SpanSpec.Quote>().size)
            val row = specs.filterIsInstance<SpanSpec.ListRow>().single()
            assertTrue(row.first)
            assertEquals(0, row.start)
            assertEquals(0, row.end)
        }
    }

    private fun projection(text: String, blocks: List<EditorBlockDescription>) = EditorProjection(
        0uL, EditorByteRange(0uL, text.toByteArray(Charsets.UTF_8).size.toULong()), text,
        emptyList(), emptyList(), blocks, emptyList(), emptyList(), emptyList(),
    )

    private fun block(from: Int, to: Int, first: Boolean, code: Boolean = true, number: Long? = null, quote: Int = 0, checked: Boolean? = null, depth: Int = 1) = EditorBlockDescription(
        EditorByteRange(from.toULong(), to.toULong()), 0u, quote.toULong(), false,
        EditorListDescription(depth.toULong(), number?.toULong(), checked, first), code, null, false,
    )
}
