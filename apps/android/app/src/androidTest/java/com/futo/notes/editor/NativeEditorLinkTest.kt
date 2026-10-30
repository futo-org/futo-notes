package com.futo.notes.editor

import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.util.UUID
import org.junit.Assert.*
import org.junit.Test
import uniffi.futo_notes_ffi.*

/** Generated Kotlin API consumer; the shared engine supplies all link policy. */
class NativeEditorLinkTest {
    @Test
    fun linkDestinationsSurviveCorrectionCommandsHistoryAndRecovery() {
        val root = File(InstrumentationRegistry.getInstrumentation().targetContext.cacheDir, "editor-links-${UUID.randomUUID()}")
        check(root.mkdirs())
        try {
            NoteStore(root.absolutePath).use { store ->
                store.createNote("links", "", "[teh __😀 docs__](https://old.test 'Title')\r\n")
                store.openEditor("links").use { session ->
                    var display = "teh 😀 docs\r\n".toByteArray(Charsets.UTF_8)
                    var revision = 0uL
                    fun apply(change: EditorViewChange) {
                        assertEquals(revision, change.previousRevision)
                        assertEquals(revision + 1uL, change.revision)
                        display = display.copyOfRange(0, change.range.start.toInt()) + change.inserted.toByteArray(Charsets.UTF_8) + display.copyOfRange(change.range.end.toInt(), display.size)
                        revision = change.revision
                    }
                    apply(session.replaceUtf16(0uL, EditorUtf16Range(0uL, 3uL), "the".map { it.code.toUShort() }))
                    val link = checkNotNull(session.inspectLink(1uL, EditorByteRange(1uL, 2uL)))
                    assertEquals("https://old.test", link.destination)
                    assertEquals(EditorByteRange(0uL, 13uL), link.range)
                    assertEquals(EditorUtf16Range(0uL, 11uL), session.displayToUtf16(1uL, link.range))
                    apply(checkNotNull(session.setLink(1uL, EditorByteRange(1uL, 2uL), "https://x.test")))
                    val updated = "[the __😀 docs__](https://x.test 'Title')\r\n"
                    assertEquals(updated, session.sourceText())
                    assertEquals("the 😀 docs\r\n", display.toString(Charsets.UTF_8))
                    apply(checkNotNull(session.undo(2uL)))
                    assertEquals("[the __😀 docs__](https://old.test 'Title')\r\n", session.sourceText())
                    apply(checkNotNull(session.redo(3uL)))
                    session.flushRecovery()
                    session.detach()
                }
                store.openEditor("links").use { recovered ->
                    assertEquals("[the __😀 docs__](https://x.test 'Title')\r\n", recovered.sourceText())
                    assertEquals("https://x.test", recovered.project(4uL, EditorByteRange(0uL, 15uL)).links.first().destination)
                    recovered.checkpoint()
                    assertEquals("[the __😀 docs__](https://x.test 'Title')\r\n", store.read("links"))
                    recovered.detach()
                }
            }
        } finally { root.deleteRecursively() }
    }
    @Test
    fun referenceVisibilityAndSourceSelectionSurviveHistoryAndRecovery() {
        val root = File(InstrumentationRegistry.getInstrumentation().targetContext.cacheDir, "editor-references-${UUID.randomUUID()}")
        check(root.mkdirs())
        try {
            NoteStore(root.absolutePath).use { store ->
                val original = "[id]: <https://x.test> 'T'\n\nmiddle\n\n[one][id] end"
                val unlinked = "[id]: <https://x.test> 'T'\n\nmiddle\n\none end"
                store.createNote("references", "", original)
                store.openEditor("references").use { session ->
                    session.selectWithAffinity(0uL, EditorByteRange(9uL, 10uL), EditorAffinity.FORWARD)
                    val target = checkNotNull(session.inspectLink(0uL, EditorByteRange(8uL, 11uL)))
                    assertEquals("https://x.test", target.destination)
                    assertEquals("T", target.title)
                    val change = checkNotNull(session.setLink(0uL, EditorByteRange(9uL, 10uL), ""))
                    val opening = "middle\n\none end".toByteArray(Charsets.UTF_8)
                    val view = opening.copyOfRange(0, change.range.start.toInt()) + change.inserted.toByteArray(Charsets.UTF_8) + opening.copyOfRange(change.range.end.toInt(), opening.size)
                    assertEquals(unlinked, view.toString(Charsets.UTF_8))
                    assertEquals(EditorByteRange(37uL, 38uL), change.selection)
                    assertEquals(unlinked, session.sourceText())
                    assertEquals(EditorByteRange(9uL, 10uL), checkNotNull(session.undo(1uL)).selection)
                    assertEquals(original, session.sourceText())
                    assertEquals(EditorByteRange(37uL, 38uL), checkNotNull(session.redo(2uL)).selection)
                    session.flushRecovery()
                    session.detach()
                }
                store.openEditor("references").use { recovered ->
                    assertEquals(unlinked, recovered.sourceText())
                    assertEquals(unlinked, recovered.project(3uL, EditorByteRange(0uL, 43uL)).text)
                    recovered.checkpoint()
                    assertEquals(unlinked, store.read("references"))
                    recovered.detach()
                }
            }
        } finally { root.deleteRecursively() }
    }

}
