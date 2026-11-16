package com.futo.notes

import com.futo.notes.localization.LocalizedMessage
import com.futo.notes.ui.folderDeletedMessage
import org.junit.Assert.assertEquals
import org.junit.Test

class FolderDeletedMessageTest {
    @Test
    fun emptyFolderSaysOnlyFolderDeleted() {
        assertEquals(LocalizedMessage("folders.deleted"), folderDeletedMessage(0, "Empty"))
    }

    @Test
    fun keptNotesAreCountedAndNameTheFolder() {
        assertEquals(
            LocalizedMessage("folders.delete.keptToast", mapOf("count" to 2L, "folderName" to "Trip")),
            folderDeletedMessage(2, "Trip"),
        )
    }
}
