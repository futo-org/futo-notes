package com.futo.notes.ui.navigation

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The folder being browsed lives in the typed nav stack, so the semantics the
 * drawer era kept on `NoteListState` (follow a renamed folder, drop a deleted
 * one) are stack rewrites. These are the pure rules behind
 * `AppNavigator.followFolderMove` / `retainFolders`.
 */
class AppNavStackTest {
    @Test
    fun `every stacked folder route follows a renamed or moved ancestor`() {
        assertEquals(
            listOf(
                Screen.Folder(""),
                Screen.Folder("Archive/Projects"),
                Screen.Folder("Archive/Projects/Plans"),
            ),
            rebaseFolderRoutes(
                listOf(
                    Screen.Folder(""),
                    Screen.Folder("Projects"),
                    Screen.Folder("Projects/Plans"),
                ),
                from = "Projects",
                to = "Archive/Projects",
            ),
        )
    }

    @Test
    fun `a rename leaves unrelated routes and the root alone`() {
        assertEquals(
            listOf(Screen.Folder(""), Screen.Folder("Inbox"), Screen.Editor("Inbox/Plan", false)),
            rebaseFolderRoutes(
                listOf(Screen.Folder(""), Screen.Folder("Inbox"), Screen.Editor("Inbox/Plan", false)),
                from = "Projects",
                to = "Archive/Projects",
            ),
        )
    }

    @Test
    fun `a deleted folder and its descendants leave the stack`() {
        assertEquals(
            listOf(Screen.Folder("")),
            pruneFolderRoutes(
                listOf(
                    Screen.Folder(""),
                    Screen.Folder("Projects"),
                    Screen.Folder("Projects/Plans"),
                ),
                folders = setOf("Inbox"),
            ),
        )
    }

    @Test
    fun `pruning pops only to the nearest surviving ancestor`() {
        assertEquals(
            listOf(Screen.Folder(""), Screen.Folder("Projects")),
            pruneFolderRoutes(
                listOf(
                    Screen.Folder(""),
                    Screen.Folder("Projects"),
                    Screen.Folder("Projects/Plans"),
                ),
                folders = setOf("Projects"),
            ),
        )
    }

    @Test
    fun `the root route is never pruned, so the stack floor holds`() {
        assertEquals(
            listOf(Screen.Folder("")),
            pruneFolderRoutes(listOf(Screen.Folder("")), folders = emptySet()),
        )
    }

    @Test
    fun `a note stays open when the folder under it is deleted by a sync pull`() {
        // The note itself survives a move-up folder delete; ejecting the user
        // from the editor would be a worse answer than changing where Back lands.
        assertEquals(
            listOf(Screen.Folder(""), Screen.Editor("Plan", false)),
            pruneFolderRoutes(
                listOf(
                    Screen.Folder(""),
                    Screen.Folder("Projects"),
                    Screen.Editor("Plan", false),
                ),
                folders = emptySet(),
            ),
        )
    }
}
