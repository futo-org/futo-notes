package com.futo.notes.editor

import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.util.UUID
import org.json.JSONArray
import org.junit.Assert.*
import uniffi.futo_notes_ffi.*

// Thin native consumer: every source, display, caret and ordinal is a shared literal.
internal fun sharedListActions() {
    val context = InstrumentationRegistry.getInstrumentation().context
    val cases = JSONArray(context.assets.open("list-actions.json").bufferedReader().use { it.readText() })
    val shortcuts = JSONArray(context.assets.open("list-shortcuts.json").bufferedReader().use { it.readText() })
    assertEquals(24, cases.length())
    assertEquals(38, shortcuts.length())
    for (at in 0 until shortcuts.length()) cases.put(shortcuts.getJSONObject(at))
    val staging = JSONArray(context.assets.open("list-staging.json").bufferedReader().use { it.readText() })
    assertEquals(12, staging.length())
    for (at in 0 until staging.length()) cases.put(staging.getJSONObject(at))
    val nested = JSONArray(context.assets.open("nested-containers.json").bufferedReader().use { it.readText() })
    assertEquals(35, nested.length())
    for (at in 0 until nested.length()) cases.put(nested.getJSONObject(at))
    val commands = JSONArray(context.assets.open("container-commands.json").bufferedReader().use { it.readText() })
    assertEquals(18, commands.length())
    for (at in 0 until commands.length()) cases.put(commands.getJSONObject(at))
    fun native(values: JSONArray) = EditorUtf16Range(values.getLong(0).toULong(), values.getLong(1).toULong())
    for (at in 0 until cases.length()) {
        val item = cases.getJSONObject(at)
        val root = File(InstrumentationRegistry.getInstrumentation().targetContext.cacheDir, "editor-lists-${UUID.randomUUID()}")
        check(root.mkdirs())
        try {
            NoteStore(root.absolutePath).use { store ->
                store.createNote("lists", "", item.getString("source"))
                fun checkItems(s: NativeEditorSession) {
                    val end = item.getString("shown").toByteArray(Charsets.UTF_8).size.toULong()
                    val blocks = (s.project(s.revision(), EditorByteRange(0uL, end)).blocks + s.project(s.revision(), EditorByteRange(end, end)).blocks).distinct()
                    val lists = blocks.filter { it.list?.first == true }
                    val expected = item.getJSONArray("finalItems")
                    assertEquals(expected.length(), lists.size)
                    lists.forEachIndexed { index, block ->
                        val list = block.list!!
                        val shape = expected.getJSONArray(index)
                        assertEquals((item.optJSONArray("itemDepths")?.getLong(index) ?: 1L).toULong(), list.depth)
                        assertEquals(if (shape.isNull(0)) null else shape.getLong(0).toULong(), list.number)
                        assertEquals(if (shape.isNull(1)) null else shape.getBoolean(1), list.checked)
                        assertEquals(item.optJSONArray("itemQuoteDepths")?.getLong(index)?.toULong() ?: item.optLong("quoteDepth", 0).toULong(), block.quoteDepth)
                    }
                }
                store.openEditor("lists").use { s ->
                    var view = item.getString("display").toByteArray(Charsets.UTF_8)
                    fun apply(change: EditorViewChange?, expectedRange: JSONArray? = null) {
                        checkNotNull(change)
                        view = view.copyOfRange(0, change.range.start.toInt()) + change.inserted.toByteArray(Charsets.UTF_8) + view.copyOfRange(change.range.end.toInt(), view.size)
                        if (expectedRange != null) assertEquals(native(expectedRange), s.displayToUtf16(change.revision, change.selection))
                    }
                    assertEquals(item.getString("display"), s.displayText())
                    val initial = item.optJSONArray("selection") ?: item.getJSONArray("range")
                    s.selectUtf16(0uL, native(initial))
                    val selected = native(item.getJSONArray("range"))
                    val action = item.getString("action")
                    val inserted = item.optString("text", "").map { it.code.toUShort() }
                    if (item.has("composeRange")) {
                        s.composeUtf16(0uL, native(item.getJSONArray("composeRange")), item.optString("compositionText", item.optString("text", "")).map { it.code.toUShort() })
                        assertEquals(item.getString("source"), s.sourceText())
                    }
                    val change = when (action) {
                        "Typing" -> s.replaceUtf16Action(0uL, selected, inserted, EditorInputAction.TYPING)
                        "Enter", "Backspace", "Delete" -> s.paragraphKeyUtf16(0uL, selected, if (action == "Enter") EditorParagraphKey.ENTER else if (action == "Delete") EditorParagraphKey.DELETE else EditorParagraphKey.BACKSPACE)
                        else -> s.blockCommandUtf16(0uL, selected, when (action) {
                            "Text" -> EditorBlockCommand.Heading(0u)
                            "Heading2" -> EditorBlockCommand.Heading(2u)
                            "Indent" -> EditorBlockCommand.Indent
                            "Outdent" -> EditorBlockCommand.Outdent
                            "BulletList" -> EditorBlockCommand.BulletList
                            "OrderedList" -> EditorBlockCommand.OrderedList
                            "TaskList" -> EditorBlockCommand.TaskList
                            "ToggleTask", "ComposeToggleTask" -> EditorBlockCommand.ToggleTask
                            else -> error("Unknown fixture action $action")
                        })
                    }
                    apply(change, item.getJSONArray("resultRange"))
                    assertEquals(1uL, s.revision())
                    assertEquals(item.getString("expected"), s.sourceText())
                    assertEquals(item.getString("shown"), view.toString(Charsets.UTF_8))
                    checkItems(s)
                    val history = item.optJSONArray("undoSources")?.length() ?: 1
                    for (step in 0 until history) {
                        apply(s.undo(s.revision()), item.optJSONArray("undoRanges")?.getJSONArray(step) ?: initial)
                        assertEquals(item.optJSONArray("undoSources")?.getString(step) ?: item.getString("source"), s.sourceText())
                        assertEquals(item.optJSONArray("undoDisplays")?.getString(step) ?: item.getString("display"), view.toString(Charsets.UTF_8))
                    }
                    assertNull(s.undo(s.revision()))
                    repeat(history) { step -> apply(s.redo(s.revision()), if (step == history - 1) item.getJSONArray("resultRange") else null) }
                    assertEquals(item.getString("expected"), s.sourceText())
                    assertEquals(item.getString("shown"), view.toString(Charsets.UTF_8))
                    s.flushRecovery()
                    s.detach()
                }
                store.openEditor("lists").use { recovered ->
                    assertEquals(item.getString("expected"), recovered.sourceText())
                    assertEquals(item.getString("shown"), recovered.displayText())
                    checkItems(recovered)
                    assertNull(recovered.undo(recovered.revision()))
                    recovered.checkpoint()
                    assertEquals(item.getString("expected"), store.read("lists"))
                    recovered.detach()
                }
                store.openEditor("lists").use { reopened ->
                    assertEquals(item.getString("expected"), reopened.sourceText())
                    reopened.detach()
                }
            }
        } finally { root.deleteRecursively() }
    }
}
