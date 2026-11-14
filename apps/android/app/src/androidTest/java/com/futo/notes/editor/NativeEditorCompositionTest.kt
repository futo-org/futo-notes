package com.futo.notes.editor

import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.util.UUID
import org.junit.Assert.*
import org.junit.Test
import uniffi.futo_notes_ffi.*

/** Binding acceptance, not a claim of driving a real Japanese keyboard. */
class NativeEditorCompositionTest {
    @Test
    fun markedJapaneseChangedCommitCorrectionAndExactSave() {
        val root = File(InstrumentationRegistry.getInstrumentation().targetContext.cacheDir, "editor-composition-${UUID.randomUUID()}")
        check(root.mkdirs())
        fun units(text: String) = text.map { it.code.toUShort() }
        try {
            NoteStore(root.absolutePath).use { store ->
                store.createNote("input", "", "__teh__ & wrng\r\n")
                store.openEditor("input").use { session ->
                    var view = "teh & wrng\r\n".toByteArray()
                    fun apply(change: EditorViewChange) {
                        view = view.copyOfRange(0, change.range.start.toInt()) + change.inserted.toByteArray() + view.copyOfRange(change.range.end.toInt(), view.size)
                    }
                    val marked = session.composeUtf16(0uL, EditorUtf16Range(0uL, 3uL), units("にほん"))
                    assertEquals("にほん", marked.text)
                    assertEquals("__teh__ & wrng\r\n", session.sourceText())
                    assertNull(session.undo(0uL))
                    try {
                        session.composeUtf16(0uL, EditorUtf16Range(0uL, 3uL), listOf(0xd800u.toUShort()))
                        fail("Malformed marked input was accepted")
                    } catch (_: EditorSessionException.InvalidText) {}
                    try {
                        session.replaceUtf16Action(0uL, EditorUtf16Range(0uL, 1uL), units("the"), EditorInputAction.COMPOSITION_COMMIT)
                        fail("Mixed composition ownership was accepted")
                    } catch (_: EditorSessionException.CompositionActive) {}
                    apply(checkNotNull(session.commitCompositionUtf16(0uL, units("the"))))
                    apply(checkNotNull(session.replaceOsUtf16(1uL, EditorUtf16Range(0uL, 12uL), units("the & wrong\uFFFC\r\n"), listOf(EditorUtf16Range(11uL, 12uL)))))
                    assertEquals("the & wrong\r\n", view.toString(Charsets.UTF_8))
                    assertEquals("__the__ & wrong\r\n", session.sourceText())
                    apply(checkNotNull(session.undo(2uL)))
                    assertEquals("__the__ & wrng\r\n", session.sourceText())
                    apply(checkNotNull(session.redo(3uL)))
                    session.detach()
                }
                store.openEditor("input").use { reopened ->
                    assertEquals("__the__ & wrong\r\n", reopened.sourceText())
                    assertNull(reopened.composition())
                    assertNull(reopened.commitCompositionUtf16(0uL, null))
                    reopened.cancelComposition(0uL)
                    reopened.detach()
                }
            }
        } finally { root.deleteRecursively() }
    }
}
