package com.futo.notes

import com.futo.notes.ui.folderDeletedMessage
import org.junit.Assert.assertEquals
import org.junit.Test

class FolderDeleteToastTest {
    @Test
    fun retainsTheCountForCatalogPluralSelection() {
        for (count in listOf(0u, 1u, 3u)) {
            val message = folderDeletedMessage(count)
            assertEquals("folders.delete.movedNotes", message.path)
            assertEquals(count.toLong(), message.arguments["count"])
        }
    }
}
