package com.futo.notes.editor

import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.util.UUID
import org.junit.Assert.*
import uniffi.futo_notes_ffi.*

fun runNativeEditorFenceContract() {
    val root = File(InstrumentationRegistry.getInstrumentation().targetContext.cacheDir, "editor-fences-${UUID.randomUUID()}")
    check(root.mkdirs())
    try {
        NoteStore(root.absolutePath).use { store ->
            val opening = "~~~~ c++ info\r\n猫🦊\r\n~~~~~  \r\n\n__tail__"
            val expected = "~~~~ c++ info\r\n猫\n🦊\r\n~~~~~  \r\n\n__tail__"
            store.createNote("code", "", opening)
            store.openEditor("code").use { session ->
                assertEquals("猫🦊\r\n\ntail", session.displayText())
                val change = session.paragraphKeyUtf16(0uL, EditorUtf16Range(1uL, 1uL), EditorParagraphKey.ENTER)
                assertEquals("c++", change!!.projection.blocks.first { it.code }.language)
                assertEquals(expected, session.sourceText())
                assertEquals("猫\n🦊\r\n\ntail", session.displayText())
                session.undo(1uL)
                assertEquals(opening, session.sourceText())
                session.redo(2uL)
                session.flushRecovery()
                session.detach()
            }
            store.openEditor("code").use { recovered ->
                assertEquals(expected, recovered.sourceText())
                recovered.checkpoint()
                assertEquals(expected, store.read("code"))
                recovered.detach()
            }
            store.createNote("tabs", "", "~~~js\nab\n cd\n~~~")
            store.openEditor("tabs").use { tabs ->
                tabs.paragraphKeyUtf16(0uL, EditorUtf16Range(1uL, 1uL), EditorParagraphKey.TAB)
                assertEquals("~~~js\na  b\n cd\n~~~", tabs.sourceText())
                tabs.paragraphKeyUtf16(1uL, EditorUtf16Range(6uL, 6uL), EditorParagraphKey.SHIFT_TAB)
                assertEquals("~~~js\na  b\ncd\n~~~", tabs.sourceText())
                tabs.detach()
            }
            store.createNote("command", "", "ab")
            store.openEditor("command").use { command ->
                command.blockCommandUtf16(0uL, EditorUtf16Range(0uL, 0uL), EditorBlockCommand.CodeBlock)
                assertEquals("```\nab\n```", command.sourceText())
                command.detach()
            }
        }
    } finally { root.deleteRecursively() }
}
