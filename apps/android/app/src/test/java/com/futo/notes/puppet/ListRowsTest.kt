package com.futo.notes.puppet

import com.futo.notes.NoteItem
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * A list screen's rows as the agent sees them: OpenNote, OpenFolder and ScrollToRow act only
 * on a row the list on screen shows.
 */
class ListRowsTest {
    private fun note(id: String, folder: String) =
        NoteItem(id, id.substringAfterLast('/'), folder, 0, "", "", emptyList())

    private val notes = listOf(note("Seed 01", ""), note("ideas/x", "ideas"), note("ideas/deep/y", "ideas/deep"))
    private val folders = listOf("ideas", "ideas/deep")

    @Test
    fun onlyARowOfThisListIsTaken() {
        val rootRows = listOf(folderRowTag("ideas"), noteRowTag("Seed 01"))
        assertNull(rowRefusal(noteRowTag("Seed 01"), rootRows, notes, folders))
        fun refusal(tag: String) = rowRefusal(tag, rootRows, notes, folders)!!.let { it.status to it.message }
        assertEquals(409 to "`ideas/x` has no row on this screen", refusal(noteRowTag("ideas/x")))
        assertEquals(409 to "`ideas/deep` has no row on this screen", refusal(folderRowTag("ideas/deep")))
        // A name that is nothing at all is a bad argument, not a wrong screen.
        assertEquals(400 to "no such note: ghost", refusal(noteRowTag("ghost")))
        assertEquals(400 to "no such folder: ghost", refusal(folderRowTag("ghost")))
    }

    @Test
    fun aRowMovesTheLeastDistanceThatShowsItWhole() {
        // The window is 0..1000; the row is 100 tall.
        assertEquals("fully visible: stays", 300, revealedOffset(300, 100, 0, 1000))
        assertEquals("touching both edges still fits", 900, revealedOffset(900, 100, 0, 1000))
        assertEquals("above, even partly: its top edge at the top", 0, revealedOffset(-40, 100, 0, 1000))
        assertEquals("below, even partly: its bottom edge at the bottom", 900, revealedOffset(950, 100, 0, 1000))
        assertEquals("far below: the same place", 900, revealedOffset(5000, 100, 0, 1000))
        assertEquals("taller than the window: its top at the top", 0, revealedOffset(400, 1200, 0, 1000))
    }
}
