package com.futo.notes.editor

import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.util.UUID
import org.junit.Assert.*
import org.junit.Test
import uniffi.futo_notes_ffi.*

class NativeEditorBlockRegressionTest {
    private data class Case(val opening: String, val command: EditorBlockCommand, val expected: String, val shown: String, val caret: ULong)

    @Test
    fun blockConversionsPreserveSpacesQuoteDepthAndPhysicalSetextPrefixes() {
        val root = File(InstrumentationRegistry.getInstrumentation().targetContext.cacheDir, "editor-block-regressions-${UUID.randomUUID()}")
        check(root.mkdirs())
        try {
            NoteStore(root.absolutePath).use { store ->
                val cases = listOf(
                    Case("   foo", EditorBlockCommand.Heading(2u), "## &#32;  foo", "   foo", 6uL),
                    Case("   # foo", EditorBlockCommand.Heading(0u), "foo", "foo", 0uL),
                    Case("> > ## 猫🦊 ##", EditorBlockCommand.Quote, "> > 猫🦊", "猫🦊", 0uL),
                    Case("> foo\r\n> bar\r\n> ===", EditorBlockCommand.Heading(0u), "> foo\r\n> bar", "foo\r\nbar", 5uL),
                )
                cases.forEachIndexed { index, case ->
                    val id = "block-$index"
                    store.createNote(id, "", case.opening)
                    store.openEditor(id).use { session ->
                        assertEquals(case.shown, session.displayText())
                        val change = checkNotNull(session.blockCommandUtf16(0uL, EditorUtf16Range(case.caret, case.caret), case.command))
                        assertEquals(case.expected, session.sourceText())
                        assertEquals(case.shown, session.displayText())
                        assertEquals(EditorByteRange(case.caret, case.caret), change.selection)
                        session.undo(1uL)
                        assertEquals(case.opening, session.sourceText())
                        session.redo(2uL)
                        session.flushRecovery()
                        session.detach()
                    }
                    store.openEditor(id).use { recovered ->
                        assertEquals(case.expected, recovered.sourceText())
                        assertEquals(case.shown, recovered.displayText())
                        recovered.checkpoint()
                        assertEquals(case.expected, store.read(id))
                        recovered.detach()
                    }
                }
            }
        } finally { root.deleteRecursively() }
    }
    @Test
    fun setextPhysicalOwnershipAndHeadingEnterPreserveNativeRangesAndRecovery() {
        data class Case(val opening: String, val shown: String, val action: String, val start: ULong,
                        val end: ULong, val expected: String, val display: String, val caret: ULong)
        val cases = listOf(
            Case("#x\n=", "#x", "text", 0uL, 2uL, "#x", "#x", 2uL),
            Case("> x\n> y\n> =", "x\ny", "indent", 0uL, 3uL, "> > x\n> > y\n> > =", "x\ny", 3uL),
            Case("> > x\r\n> > y\r\n> > ---", "x\r\ny", "outdent", 0uL, 4uL,
                 "> x\r\n> y\r\n> ---", "x\r\ny", 4uL),
            Case("> > 猫🦊\r\n> > e\u0301\r\n> > ===", "猫🦊\r\ne\u0301", "enter", 5uL, 5uL,
                 "> > 猫🦊\r\n> > ===\r\n\n> > e\u0301", "猫🦊\r\n\ne\u0301", 6uL),
            Case("> # x", "x", "enter", 0uL, 1uL, "> # \n> ", "\n", 1uL),
            Case("> x\n> =", "x", "enter", 0uL, 1uL, "> # \n> ", "\n", 1uL),
            Case("> x\n> =", "x", "delete", 0uL, 1uL, "> # ", "", 0uL),
        )
        for (case in cases) {
            val root = File(InstrumentationRegistry.getInstrumentation().targetContext.cacheDir, "editor-setext-${UUID.randomUUID()}")
            check(root.mkdirs())
            try {
                NoteStore(root.absolutePath).use { store ->
                    store.createNote("setext", "", case.opening)
                    store.openEditor("setext").use { session ->
                        assertEquals(case.shown, session.displayText())
                        val selected = EditorUtf16Range(case.start, case.end)
                        session.selectUtf16(0uL, selected)
                        val change = checkNotNull(when (case.action) {
                            "enter" -> session.paragraphKeyUtf16(0uL, selected, EditorParagraphKey.ENTER)
                            "delete" -> session.replaceUtf16(0uL, selected, emptyList())
                            else -> session.blockCommandUtf16(0uL, selected, when (case.action) {
                                "text" -> EditorBlockCommand.Heading(0u)
                                "indent" -> EditorBlockCommand.Indent
                                else -> EditorBlockCommand.Outdent
                            })
                        })
                        val before = case.shown.toByteArray(Charsets.UTF_8)
                        val view = before.copyOfRange(0, change.range.start.toInt()) + change.inserted.toByteArray(Charsets.UTF_8) + before.copyOfRange(change.range.end.toInt(), before.size)
                        assertEquals(case.display, view.toString(Charsets.UTF_8))
                        assertEquals(case.expected, session.sourceText())
                        assertEquals(case.caret, session.displayToUtf16(1uL, change.selection).end)
                        session.undo(1uL)
                        assertEquals(case.opening, session.sourceText())
                        session.redo(2uL)
                        assertEquals(case.expected, session.sourceText())
                        session.flushRecovery()
                        session.detach()
                    }
                    store.openEditor("setext").use { recovered ->
                        assertEquals(case.expected, recovered.sourceText())
                        assertEquals(case.display, recovered.displayText())
                        recovered.checkpoint()
                        assertEquals(case.expected, store.read("setext"))
                        recovered.detach()
                    }
                }
            } finally { root.deleteRecursively() }
        }
    }

}
