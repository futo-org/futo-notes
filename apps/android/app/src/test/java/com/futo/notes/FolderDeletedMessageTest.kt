package com.futo.notes

import com.futo.notes.localization.LocalizedMessage
import com.futo.notes.ui.folderDeletedMessage
import org.junit.Assert.assertEquals
import org.junit.Test

class FolderDeletedMessageTest {
    @Test
    fun emptyFolderSaysOnlyFolderDeleted() {
        assertEquals(LocalizedMessage("folders.deleted"), folderDeletedMessage(0u))
    }

    @Test
    fun movedNotesAreCounted() {
        assertEquals(
            LocalizedMessage("folders.delete.movedNotes", mapOf("count" to 2L)),
            folderDeletedMessage(2u),
        )
    }
}
