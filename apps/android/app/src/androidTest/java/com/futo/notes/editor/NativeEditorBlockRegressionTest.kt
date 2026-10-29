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
}
