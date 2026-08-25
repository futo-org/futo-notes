package com.futo.notes

import com.futo.notes.ui.components.eligibleFolderDestinations
import com.futo.notes.ui.rebaseFolderPath
import org.junit.Assert.assertEquals
import org.junit.Test

class FolderActionsTest {
    @Test
    fun `move picker excludes the source folder and every descendant`() {
        assertEquals(
            listOf("Archive", "Inbox"),
            eligibleFolderDestinations(
                folders = listOf("Archive", "Projects", "Projects/Plans", "Inbox"),
                excludePaths = listOf("Projects"),
            ),
        )
    }

    @Test
    fun `active folder path follows a renamed or moved ancestor`() {
        assertEquals(
            "Archive/Projects/Plans",
            rebaseFolderPath(
                current = "Projects/Plans",
                from = "Projects",
                to = "Archive/Projects",
            ),
        )
        assertEquals(
            "Inbox",
            rebaseFolderPath(current = "Inbox", from = "Projects", to = "Archive/Projects"),
        )
    }

    @Test
    fun `the root folder screen lists only top-level folders`() {
        assertEquals(
            listOf("Archive", "Inbox", "Projects"),
            immediateSubfolders(
                folders = listOf("Archive", "Inbox", "Projects", "Projects/Plans", "Projects/Plans/Q3"),
                of = "",
            ),
        )
    }

    @Test
    fun `a folder screen lists its immediate children, not its whole subtree`() {
        assertEquals(
            listOf("Projects/Plans", "Projects/Specs"),
            immediateSubfolders(
                folders = listOf(
                    "Projects",
                    "Projects/Plans",
                    "Projects/Plans/Q3",
                    "Projects/Specs",
                    "ProjectsArchive",
                ),
                of = "Projects",
            ),
        )
    }

    @Test
    fun `a leaf folder has no subfolders and never lists itself`() {
        assertEquals(
            emptyList<String>(),
            immediateSubfolders(folders = listOf("Projects", "Projects/Plans"), of = "Projects/Plans"),
        )
    }

    @Test
    fun `derivation preserves the engine's alphabetical folder order`() {
        // `folders` comes from a Rust BTreeSet; the shell adds no comparator.
        assertEquals(
            listOf("a", "B", "c"),
            immediateSubfolders(folders = listOf("a", "B", "c"), of = ""),
        )
    }
}
