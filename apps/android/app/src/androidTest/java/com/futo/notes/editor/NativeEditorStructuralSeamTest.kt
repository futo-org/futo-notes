package com.futo.notes.editor

import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.util.UUID
import org.json.JSONArray
import org.junit.Assert.*
import org.junit.Test
import uniffi.futo_notes_ffi.*

/** Synthetic binding/recovery checks; these are not captured OS callbacks. */
class NativeEditorStructuralSeamTest {
    @Test
    fun structuralSeamsAndRawMarkedInputKeepExactNativeCaretsAndRecovery() {
        val context = InstrumentationRegistry.getInstrumentation().context
        val cases = JSONArray(context.assets.open("structural-seams.json").bufferedReader().use { it.readText() })
        assertEquals(12, cases.length())
        for (index in 0 until cases.length()) {
            val item = cases.getJSONObject(index)
            val root = File(InstrumentationRegistry.getInstrumentation().targetContext.cacheDir, "editor-seams-${UUID.randomUUID()}")
            check(root.mkdirs())
            try {
                NoteStore(root.absolutePath).use { store ->
                    val opening = item.getString("source")
                    store.createNote("seam", "", opening)
                    store.openEditor("seam").use { s ->
                        var view = item.getString("display").toByteArray(Charsets.UTF_8)
                        var last: EditorByteRange? = null
                        fun apply(delta: EditorViewChange?) {
                            val change = checkNotNull(delta)
                            view = view.copyOfRange(0, change.range.start.toInt()) + change.inserted.toByteArray(Charsets.UTF_8) + view.copyOfRange(change.range.end.toInt(), view.size)
                            last = change.selection
                        }
                        val values = item.getJSONArray("range")
                        val selected = EditorUtf16Range(values.getLong(0).toULong(), values.getLong(1).toULong())
                        fun units(text: String) = text.map { it.code.toUShort() }
                        val inserted = units(item.getString("text"))
                        val mode = item.getString("mode")
                        if (mode == "noop_indent") {
                            assertNull(s.blockCommandUtf16(0uL, EditorUtf16Range(0uL, 0uL), EditorBlockCommand.Heading(1u)))
                            assertEquals(0uL, s.revision())
                            assertEquals(opening, s.sourceText())
                        }
                        if (mode in listOf("indent", "noop_indent", "indent_os")) apply(s.blockCommandUtf16(s.revision(), EditorUtf16Range(0uL, 0uL), EditorBlockCommand.Indent))
                        when (mode) {
                            "composition_commit" -> {
                                for (text in listOf("に", "日本")) {
                                    assertEquals(text, s.composeUtf16(0uL, selected, units(text)).text)
                                    assertEquals(opening, s.sourceText())
                                    assertEquals(0uL, s.revision())
                                }
                                s.cancelComposition(0uL)
                                assertNull(s.composition())
                                s.composeUtf16(0uL, selected, inserted)
                                apply(s.commitCompositionUtf16(0uL, null))
                            }
                            "composition_os", "distant_composition_os" -> {
                                s.composeUtf16(0uL, EditorUtf16Range(if (mode == "distant_composition_os") 17uL else 0uL, if (mode == "distant_composition_os") 17uL else 0uL), units("!"))
                                apply(s.replaceOsUtf16(0uL, selected, inserted, emptyList()))
                                assertEquals(1uL, s.revision())
                            }
                            "os", "indent_os" -> apply(s.replaceOsUtf16(s.revision(), selected, inserted, emptyList()))
                            "typing" -> apply(s.replaceUtf16Action(0uL, selected, inserted, EditorInputAction.ISOLATED))
                            "batch" -> apply(s.replaceManyUtf16(0uL, listOf(EditorUtf16Replacement(EditorUtf16Range(0uL, 1uL), units("!")), EditorUtf16Replacement(EditorUtf16Range(1uL, 2uL), units("?")), EditorUtf16Replacement(EditorUtf16Range(3uL, 5uL), units("AC")))))
                        }
                        assertEquals(item.getString("expectedDisplay"), view.toString(Charsets.UTF_8))
                        assertEquals(item.getString("expectedSource"), s.sourceText())
                        val caret = s.displayToUtf16(s.revision(), checkNotNull(last))
                        assertEquals(item.getLong("caret").toULong(), caret.start)
                        assertEquals(caret.start, caret.end)
                        repeat(item.getInt("history")) { checkNotNull(s.undo(s.revision())) }
                        assertEquals(opening, s.sourceText())
                        repeat(item.getInt("history")) { checkNotNull(s.redo(s.revision())) }
                        assertEquals(item.getString("expectedSource"), s.sourceText())
                        s.flushRecovery()
                        s.detach()
                    }
                    store.openEditor("seam").use { recovered ->
                        assertEquals(item.getString("expectedSource"), recovered.sourceText())
                        assertEquals(item.getString("expectedDisplay"), recovered.displayText())
                        recovered.checkpoint()
                        assertEquals(item.getString("expectedSource"), store.read("seam"))
                        recovered.detach()
                    }
                }
            } finally { root.deleteRecursively() }
        }
    }
}
