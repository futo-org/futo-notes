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
}
