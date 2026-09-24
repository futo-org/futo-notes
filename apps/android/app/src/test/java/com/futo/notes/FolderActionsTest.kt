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
    fun `immediateSubfolders lists only direct children, in the engine's order`() {
        listOf(
            // The root folder screen lists only top-level folders.
            Triple(
                "",
                listOf("Archive", "Inbox", "Projects", "Projects/Plans", "Projects/Plans/Q3"),
                listOf("Archive", "Inbox", "Projects"),
            ),
            // A folder screen lists its immediate children, not its whole
            // subtree, and a sibling sharing its prefix is not a child.
            Triple(
                "Projects",
                listOf("Projects", "Projects/Plans", "Projects/Plans/Q3", "Projects/Specs", "ProjectsArchive"),
                listOf("Projects/Plans", "Projects/Specs"),
            ),
            // A leaf folder has no subfolders and never lists itself.
            Triple("Projects/Plans", listOf("Projects", "Projects/Plans"), emptyList()),
            // `folders` comes from a Rust BTreeSet; the shell adds no comparator.
            Triple("", listOf("a", "B", "c"), listOf("a", "B", "c")),
        ).forEach { (of, folders, expected) ->
            assertEquals("subfolders of '$of'", expected, immediateSubfolders(folders = folders, of = of))
        }
    }
}
