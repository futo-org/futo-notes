package com.futo.notes

import com.futo.notes.ui.folderDeletedToast
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Regression: the folder-delete toast read "Folder deleted; moved 1 notes"
 * for a single moved note [list.md:121] — the count must pluralize.
 */
class FolderDeleteToastTest {
    @Test
    fun singularForOneMovedNote() {
        assertEquals("Folder deleted; moved 1 note", folderDeletedToast(1u))
    }

    @Test
    fun pluralForZeroMovedNotes() {
        assertEquals("Folder deleted; moved 0 notes", folderDeletedToast(0u))
    }

    @Test
    fun pluralForManyMovedNotes() {
        assertEquals("Folder deleted; moved 3 notes", folderDeletedToast(3u))
    }
}
