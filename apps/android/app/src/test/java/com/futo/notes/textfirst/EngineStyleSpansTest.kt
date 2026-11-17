package com.futo.notes.textfirst

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import uniffi.futo_notes_ffi.EditorListMarker
import uniffi.futo_notes_ffi.EditorStyleCell
import uniffi.futo_notes_ffi.EditorStyleSpan
import uniffi.futo_notes_ffi.EditorTableAlignment

class EngineStyleSpansTest {
    @Test fun listLinesTakeTheEngineLevelAndShowTheirMarkerAsTyped() {
        val spans = listOf(
            listRow(0, 2, level = 0, EditorListMarker.ORDERED, "09."),
            listRow(2, 4, level = 1, EditorListMarker.ORDERED, "3)"),
            listRow(4, 6, level = 0, EditorListMarker.TASK, "-", checked = true),
            listRow(6, 8, level = 1, EditorListMarker.BULLET, "*"),
            listRow(8, 9, level = 1, EditorListMarker.PLAIN, ""),
            EditorStyleSpan.Tag(0uL, 1uL),
        )
        val specs = spans.toStyleWindow(0, 9, "a\nb\nc\nd\ne").specs
        val rows = specs.filterIsInstance<SpanSpec.ListRow>()
        assertEquals(listOf("09.", "3)", "-", "*"), rows.map { it.label })
        assertEquals(listOf(ListMarker.Ordered, ListMarker.Ordered, ListMarker.Task, ListMarker.Bullet), rows.map { it.marker })
        assertEquals(listOf(0, 1, 0, 1), rows.map { it.depth })
        assertTrue(rows[2].checked)
        val plain = specs.filterIsInstance<SpanSpec.Indent>().single()
        assertEquals(8, plain.start)
        assertEquals(1, plain.depth)
        val tag = specs.filterIsInstance<SpanSpec.Tag>().single()
        assertEquals(0 to 1, tag.start to tag.end)
        assertEquals(6, specs.size)
    }

    // "```js\nx\ny\n```\n```py\nw\n```\n```\nv\n```" shows as "x\ny\nw\nv".
    @Test fun aCodeLanguageLabelsOnlyTheFirstCodeLineOfEachBlock() {
        val spans = listOf(
            EditorStyleSpan.CodeBlock(0uL, 3uL, "js", null, 2u),
            EditorStyleSpan.CodeBlock(4uL, 5uL, "py", null, 1u),
            EditorStyleSpan.CodeBlock(6uL, 7uL, null, null, 1u),
            code(0, 2, 1u, first = true, last = false),
            code(2, 4, 2u, first = false, last = true),
            code(4, 6, 1u, first = true, last = true),
            code(6, 7, 1u, first = true, last = true),
        )
        val specs = spans.toStyleWindow(0, 7, "x\ny\nw\nv").specs
        assertEquals(listOf("js", null, "py", null), specs.map { (it as SpanSpec.Code).language })
    }

    @Test fun aTableRowReadsItsCellsFromTheDisplayAndHidesTheSpansInsideIt() {
        val display = "p\n| a | b |\n|---|---|\n| c | d |\n"
        val cells = listOf(EditorStyleCell(0uL, 4uL, 5uL, EditorTableAlignment.NONE), EditorStyleCell(1uL, 8uL, 9uL, EditorTableAlignment.RIGHT))
        val spans = listOf(
            EditorStyleSpan.Inline(0uL, 1uL, true, false, false, false),
            EditorStyleSpan.Inline(4uL, 5uL, true, false, false, false),
            EditorStyleSpan.TableRow(2uL, 11uL, 2uL, true, 2uL, cells),
            EditorStyleSpan.TableDelimiter(12uL, 21uL),
        )
        val window = spans.toStyleWindow(0, 2, display)
        assertEquals("the whole table's spans replace what it drew", 0 to 21, window.start to window.end)
        assertEquals(listOf(0), window.specs.filterIsInstance<SpanSpec.Inline>().map { it.start })
        val row = window.specs.filterIsInstance<SpanSpec.TableRow>().single().row
        assertEquals(listOf("a", "b"), row.cells.map { it.text })
        assertEquals(EditorTableAlignment.RIGHT, row.cells[1].alignment)
        assertEquals(2, row.tableStart)
    }

    private fun code(start: Int, end: Int, lineNumber: UInt, first: Boolean, last: Boolean) =
        EditorStyleSpan.Code(start.toULong(), end.toULong(), lineNumber, null, first, last)

    private fun listRow(start: Int, end: Int, level: Int, marker: EditorListMarker, text: String, checked: Boolean = false) =
        EditorStyleSpan.ListRow(start.toULong(), end.toULong(), 0uL, level.toULong(), marker, text, checked, true)
}
