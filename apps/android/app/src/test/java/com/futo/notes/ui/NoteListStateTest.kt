package com.futo.notes.ui

import androidx.compose.foundation.lazy.LazyListState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class NoteListStateTest {
    @Test
    fun `selected folder remains until navigation explicitly changes it`() {
        val state = NoteListState(LazyListState())

        state.selectFolder("Projects")
        state.retainAvailableFolderPaths(listOf("Projects", "Archive"))

        assertEquals("Projects", state.selectedFolderPath)
    }

    @Test
    fun `selected folder follows a renamed or moved ancestor`() {
        val state = NoteListState(LazyListState())
        state.selectFolder("Projects/Plans")

        state.followFolderMove(from = "Projects", to = "Archive/Projects")

        assertEquals("Archive/Projects/Plans", state.selectedFolderPath)
    }

    @Test
    fun `deleting the selected folder or its ancestor returns to all notes`() {
        val state = NoteListState(LazyListState())
        state.selectFolder("Projects/Plans")

        state.handleFolderDeleted("Projects")

        assertNull(state.selectedFolderPath)
    }

    @Test
    fun `missing selected folder returns to all notes after navigation`() {
        val state = NoteListState(LazyListState())
        state.selectFolder("Projects")

        state.retainAvailableFolderPaths(listOf("Archive"))

        assertNull(state.selectedFolderPath)
    }
}
