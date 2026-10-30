package com.futo.notes.editor

import android.content.res.AssetManager
import org.json.JSONObject
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.util.UUID
import org.json.JSONArray
import org.junit.Assert.*
import org.junit.Test
import uniffi.futo_notes_ffi.*

/** Synthetic binding/recovery checks; these are not captured OS callbacks. */
class NativeEditorStructuralSeamTest {
    private fun structuralCases(assets: AssetManager): List<JSONObject> =
        listOf("structural-seams.json", "fence-physical-rows.json").flatMap { name ->
            val values = JSONArray(assets.open(name).bufferedReader().use { it.readText() })
            (0 until values.length()).map { values.getJSONObject(it) }
        }

    @Test
    fun structuralFixtureAssetsCoexistWithTheOriginalConformanceAssets() {
        val assets = InstrumentationRegistry.getInstrumentation().context.assets
        val names = checkNotNull(assets.list(""))
        assertEquals(1, names.count { it == "structural-seams.json" })
        assertEquals(1, names.count { it == "fence-physical-rows.json" })
        assertTrue(names.contains("server-url.json"))
        val readmeTitle = assets.open("README.md").bufferedReader().use { it.readLine() }
        assertEquals("# Cross-language note-rule conformance", readmeTitle)
        val cases = structuralCases(assets)
        assertEquals(64, cases.size)
    }

    @Test
    fun structuralSeamsAndRawMarkedInputKeepExactNativeCaretsAndRecovery() {
        val context = InstrumentationRegistry.getInstrumentation().context
        val cases = structuralCases(context.assets)
        assertEquals(64, cases.size)
        for (index in 0 until cases.size) {
            val item = cases[index]
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
                            "composition_batch" -> {
                                s.composeUtf16(0uL, selected, inserted)
                                assertEquals(opening, s.sourceText())
                                val runs = item.getJSONArray("replacements")
                                apply(s.replaceManyUtf16(0uL, (0 until runs.length()).map { at ->
                                    val run = runs.getJSONArray(at)
                                    EditorUtf16Replacement(EditorUtf16Range(run.getLong(0).toULong(), run.getLong(1).toULong()), units(run.getString(2)))
                                }))
                                assertEquals(1uL, s.revision())
                            }
                            "composition_os", "distant_composition_os" -> {
                                s.composeUtf16(0uL, EditorUtf16Range(if (mode == "distant_composition_os") 17uL else 0uL, if (mode == "distant_composition_os") 17uL else 0uL), units("!"))
                                apply(s.replaceOsUtf16(0uL, selected, inserted, emptyList()))
                                assertEquals(1uL, s.revision())
                            }
                            "os", "indent_os" -> apply(s.replaceOsUtf16(s.revision(), selected, inserted, emptyList()))
                            "typing_sequence" -> {
                                if (item.has("format")) {
                                    val format = when (item.getString("format")) {
                                        "Bold" -> EditorInlineFormat.BOLD
                                        "Code" -> EditorInlineFormat.CODE
                                        else -> error("invalid fixture format")
                                    }
                                    assertNull(s.toggleFormat(0uL, format))
                                }
                                var next = selected
                                val inputs = item.getJSONArray("inputs")
                                for (at in 0 until inputs.length()) {
                                    val input = inputs.getJSONArray(at)
                                    val action = when (input.getString(0)) {
                                        "Typing" -> EditorInputAction.TYPING
                                        "Isolated" -> EditorInputAction.ISOLATED
                                        else -> error("invalid fixture action")
                                    }
                                    val change = s.replaceUtf16Action(s.revision(), next, units(input.getString(1)), action)
                                    next = s.displayToUtf16(s.revision(), change.selection)
                                    apply(change)
                                }
                            }
                            "typing" -> apply(s.replaceUtf16Action(0uL, selected, inserted, EditorInputAction.ISOLATED))
                            "explicit" -> apply(s.replaceManyUtf16(0uL, listOf(EditorUtf16Replacement(selected, inserted))))
                            "batch" -> apply(s.replaceManyUtf16(0uL, listOf(EditorUtf16Replacement(EditorUtf16Range(0uL, 1uL), units("!")), EditorUtf16Replacement(EditorUtf16Range(1uL, 2uL), units("?")), EditorUtf16Replacement(EditorUtf16Range(3uL, 5uL), units("AC")))))
                        }
                        assertEquals(item.getString("expectedDisplay"), view.toString(Charsets.UTF_8))
                        assertEquals(item.getString("expectedSource"), s.sourceText())
                        val caret = s.displayToUtf16(s.revision(), checkNotNull(last))
                        assertEquals(item.getLong("caret").toULong(), caret.start)
                        assertEquals(caret.start, caret.end)
                        repeat(item.getInt("history")) { checkNotNull(s.undo(s.revision())) }
                        assertEquals(opening, s.sourceText())
                        var redone: EditorViewChange? = null
                        repeat(item.getInt("history")) { redone = checkNotNull(s.redo(s.revision())) }
                        assertEquals(item.getString("expectedSource"), s.sourceText())
                        val redoneCaret = s.displayToUtf16(s.revision(), checkNotNull(redone).selection)
                        assertEquals(item.optLong("redoCaret", item.getLong("caret")).toULong(), redoneCaret.start)
                        assertEquals(redoneCaret.start, redoneCaret.end)
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
