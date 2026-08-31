package com.futo.notes.ui

import androidx.compose.foundation.lazy.LazyListState
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertSame
import org.junit.Test

/**
 * The folder being browsed lives in the nav stack now (`Screen.Folder`), so
 * [NoteListState] is purely the per-folder scroll-position holder. Route
 * rebasing/pruning is pinned by AppNavStackTest.
 */
class NoteListStateTest {
    @Test
    fun `each folder keeps its own scroll state and the root's is the supplied one`() {
        val root = LazyListState()
        val state = NoteListState(root)

        assertSame(root, state.scrollStateFor(ROOT_FOLDER))
        val projects = state.scrollStateFor("Projects")
        assertNotSame(root, projects)
        assertSame(projects, state.scrollStateFor("Projects"))
        assertNotSame(projects, state.scrollStateFor("Projects/Plans"))
    }

    @Test
    fun `a folder that no longer exists forgets its scroll position`() {
        val state = NoteListState(LazyListState())
        val projects = state.scrollStateFor("Projects")

        state.retainFolders(listOf("Archive"))

        assertNotSame(projects, state.scrollStateFor("Projects"))
    }

    @Test
    fun `the root scroll state survives every folder disappearing`() {
        val root = LazyListState()
        val state = NoteListState(root)
        state.scrollStateFor("Projects")

        state.retainFolders(emptyList())

        assertSame(root, state.scrollStateFor(ROOT_FOLDER))
    }

    @Test
    fun `scroll position follows a renamed or moved folder and its descendants`() {
        val state = NoteListState(LazyListState())
        val projects = state.scrollStateFor("Projects")
        val plans = state.scrollStateFor("Projects/Plans")
        val untouched = state.scrollStateFor("Inbox")

        state.followFolderMove("Projects", "Archive/Projects")

        assertSame(projects, state.scrollStateFor("Archive/Projects"))
        assertSame(plans, state.scrollStateFor("Archive/Projects/Plans"))
        assertSame(untouched, state.scrollStateFor("Inbox"))
        assertNotSame(projects, state.scrollStateFor("Projects"))
    }
}
