package com.futo.notes.editor

import android.os.Process
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.util.UUID
import org.junit.Assert.*
import org.junit.Test
import uniffi.futo_notes_ffi.*

/** A small real Kotlin consumer; no replacement view or markdown policy. */
class NativeEditorSessionTest {
    @Test
    fun exactInputErrorsDeltasHistoryAndRecovery() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val require32 = InstrumentationRegistry.getArguments().getString("editorRequire32Bit") == "true"
        if (require32) assertFalse("This acceptance run requires a 32-bit native process", Process.is64Bit())
        println("EDITOR_NATIVE_CONTRACT_32BIT=${!Process.is64Bit()}")
        val root = File(instrumentation.targetContext.cacheDir, "editor-native-${UUID.randomUUID()}")
        check(root.mkdirs())
        try {
            NoteStore(root.absolutePath).use { store ->
                store.createNote("plain", "", "a😀\u0000z\r\n")
                val session = store.openEditor("plain")
                assertEquals("a😀\u0000z\r\n", session.sourceText())
                val selected = session.selectUtf16(0uL, EditorUtf16Range(1uL, 3uL))
                assertEquals(EditorByteRange(1uL, 5uL), selected.selection)
                assertEquals(EditorUtf16Range(1uL, 3uL), session.displayToUtf16(0uL, selected.selection))
                try {
                    session.replaceUtf16(0uL, EditorUtf16Range(1uL, 3uL), listOf(0xD800u.toUShort()))
                    fail("Malformed input was accepted")
                } catch (_: EditorSessionException.InvalidText) {}
                for (range in listOf(EditorUtf16Range(2uL, 3uL), EditorUtf16Range(0x100000000uL, 0x100000000uL))) {
                    try {
                        session.replaceUtf16(0uL, range, listOf(65u.toUShort()))
                        fail("Invalid range was accepted")
                    } catch (_: EditorSessionException.InvalidRange) {}
                }
                val change = session.replaceUtf16(0uL, EditorUtf16Range(1uL, 3uL), "🇯🇵\u0000".map { it.code.toUShort() })
                assertEquals(0uL, change.previousRevision)
                assertEquals(1uL, change.revision)
                assertEquals(EditorByteRange(1uL, 5uL), change.range)
                assertEquals("🇯🇵\u0000", change.inserted)
                assertEquals(EditorByteRange(10uL, 10uL), change.selection)
                assertEquals("a🇯🇵\u0000\u0000z\r\n", session.displayText())
                try {
                    session.replaceUtf16(0uL, EditorUtf16Range(0uL, 0uL), listOf(65u.toUShort()))
                    fail("Stale input was accepted")
                } catch (error: EditorSessionException.StaleRevision) {
                    assertEquals(0uL, error.expected)
                    assertEquals(1uL, error.actual)
                }
                session.undo(1uL)
                assertEquals("a😀\u0000z\r\n", session.sourceText())
                session.redo(2uL)
                assertEquals(3uL, session.flushRecovery().durable)
                session.detach()
                session.destroy()
                store.openEditor("plain").use { recovered ->
                    assertEquals("a🇯🇵\u0000\u0000z\r\n", recovered.sourceText())
                    assertEquals(3uL, recovered.revision())
                    assertEquals("plain", recovered.checkpoint().mutation?.finalId)
                    assertEquals("a🇯🇵\u0000\u0000z\r\n", store.read("plain"))
                    recovered.detach()
                }
                store.createNote("inline", "", "__日😀__ tail\r\n")
                store.openEditor("inline").use { inline ->
                    val projected = inline.project(0uL, EditorByteRange(0uL, 14uL))
                    assertEquals("日😀 tail\r\n", projected.text)
                    assertEquals(listOf(EditorInlineFormat.BOLD), projected.runs.first().formats)
                    inline.detach()
                }
            }
        } finally {
            root.deleteRecursively()
        }
    }
}
