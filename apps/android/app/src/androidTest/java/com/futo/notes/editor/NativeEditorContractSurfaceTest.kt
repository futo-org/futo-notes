package com.futo.notes.editor

import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.util.UUID
import org.junit.Assert.*
import org.junit.Test
import uniffi.futo_notes_ffi.*

/** Every later portable-session surface once through the real Store-backed session. */
class NativeEditorContractSurfaceTest {
    private fun at(start: Long, end: Long) = EditorByteRange(start.toULong(), end.toULong())

    /** Source after a reopen; detach saves, so it must equal the stored bytes. */
    private fun scenario(source: String, seed: (NoteStore) -> Unit = {}, body: (NoteStore, NativeEditorSession) -> Unit): String {
        val root = File(InstrumentationRegistry.getInstrumentation().targetContext.cacheDir, "editor-surfaces-${UUID.randomUUID()}")
        check(root.mkdirs())
        try {
            NoteStore(root.absolutePath).use { store ->
                seed(store)
                store.createNote("n", "", source)
                store.openEditor("n").use { session ->
                    body(store, session)
                    session.detach()
                }
                store.openEditor("n").use { reopened ->
                    val reopenedSource = reopened.sourceText()
                    assertEquals(reopenedSource, store.read("n"))
                    reopened.detach()
                    return reopenedSource
                }
            }
        } finally { root.deleteRecursively() }
    }

    @Test
    fun tagsFindAndClipboardKeepExactBytes() {
        assertEquals("#a #b\n\nbody", scenario("#a\n\nbody") { _, s ->
            checkNotNull(s.addHeaderTag(0uL, "b"))
            assertEquals(listOf("#a", "#b"), s.headerTags())
            assertEquals(listOf("#a", "#b"), s.tags())
        })
        val front = "---\ntitle: x\n---\nbody"
        assertEquals(front, scenario(front) { _, s ->
            val blocks = s.project(0uL, at(0, s.displayText().toByteArray(Charsets.UTF_8).size.toLong())).blocks
            assertEquals(1, blocks.count { it.metadata })
            assertFalse(blocks.last().metadata)
        })
        assertEquals("x a **bo**ld Bold\r\n\r\nBOLD", scenario("a **bo**ld Bold\r\n\r\nBOLD") { _, s ->
            val report = s.findSetQuery(0uL, "bold")
            assertEquals(3uL to 1uL, report.total to report.current)
            assertEquals(at(2, 6), report.reveal)
            assertEquals(2uL, s.findStep(0uL, true).current)
            val early = checkNotNull(s.findScanRequest())
            s.replaceUtf16(0uL, EditorUtf16Range(0uL, 0uL), "x ".map { it.code.toUShort() })
            assertTrue(s.findReport().stale)
            assertNull(s.findApplyScan(editorFindScan(early)))
            val rescanned = checkNotNull(s.findApplyScan(editorFindScan(checkNotNull(s.findScanRequest()))))
            assertEquals(3uL to false, rescanned.total to rescanned.stale)
            assertFalse(s.findClose().open)
        })
        assertEquals("- ab \n- x\n- y\n- ", scenario("- ab **cd**") { _, s ->
            assertEquals("**d**", s.copyMarkdown(0uL, at(4, 5)))
            checkNotNull(s.pasteMarkdown(0uL, at(3, 3), "- x\n- y\n"))
            assertEquals("- ab \n- x\n- y\n- **cd**", s.sourceText())
            val cut = s.cutMarkdown(1uL, at(8, 10))
            assertEquals("- **cd**", cut.markdown)
            assertNotNull(cut.change)
        })
    }

    @Test
    fun tableCellsTabAndRowInsertionKeepExactBytes() {
        val grid = "| a | b |\r\n| --- | --: |\r\n| c | d |\r\n"
        assertEquals("| ax|y | b |\r\n| --- | --: |\r\n|  |  |  |\r\n| c | d |\r\n", scenario(grid) { _, s ->
            val origin = s.utf16ToDisplay(0uL, EditorUtf16Range(0uL, 0uL))
            val table = checkNotNull(s.inspectTable(0uL, origin))
            assertEquals(2u to 2, table.columns to table.rows.size)
            val end = table.rows[0][0].content.end
            val caret = s.displayToUtf16(0uL, EditorByteRange(end, end))
            s.replaceUtf16(0uL, caret, "x|y".map { it.code.toUShort() })
            assertEquals("| ax|y | b |\r\n| --- | --: |\r\n| c | d |\r\n", s.sourceText())
            assertEquals(3u, checkNotNull(s.inspectTable(1uL, at(2, 2))).columns)
            val moved = checkNotNull(s.tableKey(1uL, EditorTableKey.TAB))
            assertEquals(1uL, moved.selected?.revision)
            assertNull(moved.edited)
            checkNotNull(s.tableCommand(1uL, at(2, 2), EditorTableCommand.INSERT_ROW_BELOW))
        })
    }

    @Test
    fun noteIdsWikilinkCompletionAndImageAtomsKeepExactBytes() {
        val seed = { store: NoteStore -> store.createNote("Roadmap", "Projects", ""); Unit }
        assertEquals("[[Roadmap]] ab", scenario("[[Roadmap]] ab", seed) { store, s ->
            val before = s.project(0uL, at(0, 11)).wikilinks[0]
            assertEquals("Roadmap" to "Projects/Roadmap", before.label to before.noteId)
            store.createNote("Roadmap", "Archive", "")
            val change = s.refreshNoteIds()
            assertEquals(0uL to 1, change.revision to change.projections.size)
            val after = s.project(0uL, at(0, 11)).wikilinks[0]
            assertEquals("Roadmap", after.label)
            assertNull(after.noteId)
        })
        assertEquals("see [[Projects/Roadmap]]", scenario("see [[Ro", seed) { _, s ->
            s.selectWithAffinity(0uL, at(8, 8), EditorAffinity.FORWARD)
            val found = checkNotNull(s.wikilinkCompletion(0uL))
            assertEquals(at(4, 8) to "Ro", found.range to found.query)
            assertEquals(listOf("Projects/Roadmap"), found.candidates.map { it.noteId })
            try {
                s.acceptWikilinkCompletion(0uL, found.range, "R", "Projects/Roadmap")
                fail("stale claim accepted")
            } catch (_: EditorSessionException.StaleClaim) {}
            s.acceptWikilinkCompletion(0uL, found.range, found.query, "Projects/Roadmap")
        })
        assertEquals("a ![x](image-1.png) b![](image-2.png)", scenario("a ![x](image-1.png) b") { _, s ->
            val atom = s.project(0uL, at(0, 21)).atoms.first()
            assertEquals(at(2, 19), atom.range)
            assertEquals("image-1.png", atom.image?.destination)
            val claim = s.imageClaim()
            s.selectWithAffinity(0uL, at(21, 21), EditorAffinity.FORWARD)
            checkNotNull(s.insertImage(0uL, claim, "image-2.png", ""))
        })
    }
}
