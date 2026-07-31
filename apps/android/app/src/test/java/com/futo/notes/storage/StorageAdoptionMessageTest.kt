package com.futo.notes.storage

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The confirmation body is the only thing standing between the user and opening a
 * folder whose notes are older than the ones they were just editing — the folder
 * being opened is often a backup this app left behind on an earlier switch. So it
 * must always state both note counts, where the current notes stay, and how old
 * the destination is.
 */
class StorageAdoptionMessageTest {
    private val now = 1_700_000_000_000L

    private fun summary(
        destinationNotes: Int = 3,
        destinationLastModifiedMs: Long = now - 3 * DAY,
        currentNotes: Int = 14,
    ) = StorageAdoptionSummary(
        destinationNotes = destinationNotes,
        destinationLastModifiedMs = destinationLastModifiedMs,
        currentPath = "/storage/emulated/0/Android/data/com.futo.notes/files/futo-notes",
        currentNotes = currentNotes,
        nowMs = now,
    )

    @Test
    fun statesBothSidesAndThatTheCurrentNotesAreKept() {
        val body = describeStorageAdoption(summary())
        assertTrue("names the destination note count", body.contains("3 notes"))
        assertTrue("names the current note count", body.contains("14 notes"))
        assertTrue("says where the current notes stay", body.contains("futo-notes"))
        assertTrue(
            "promises the current notes survive",
            body.contains("not moved or deleted"),
        )
    }

    @Test
    fun datesAStaleBackupSoOlderNotesAreRecognisable() {
        assertTrue(describeStorageAdoption(summary()).contains("3 days ago"))
        assertTrue(
            describeStorageAdoption(summary(destinationLastModifiedMs = now)).contains("today"),
        )
        assertTrue(
            describeStorageAdoption(summary(destinationLastModifiedMs = now - DAY))
                .contains("yesterday"),
        )
        assertTrue(
            describeStorageAdoption(summary(destinationLastModifiedMs = now - 400 * DAY))
                .contains("over a month ago"),
        )
    }

    /** An unknown or future mtime must not produce "last changed -2 days ago". */
    @Test
    fun omitsTheAgeWhenItIsUnknownOrInTheFuture() {
        assertFalse(
            describeStorageAdoption(summary(destinationLastModifiedMs = 0)).contains("last changed"),
        )
        assertFalse(
            describeStorageAdoption(summary(destinationLastModifiedMs = now + 5 * DAY))
                .contains("last changed"),
        )
    }

    @Test
    fun saysSoWhenTheFolderHoldsFilesButNoNotes() {
        val body = describeStorageAdoption(summary(destinationNotes = 0))
        assertTrue(body.contains("no notes"))
        assertFalse("no bogus age for a folder with no notes", body.contains("last changed"))
    }

    @Test
    fun singularNoteReadsAsOneNote() {
        val body = describeStorageAdoption(summary(destinationNotes = 1, currentNotes = 1))
        assertTrue(body.contains("1 note"))
        assertFalse(body.contains("1 notes"))
    }

    private companion object {
        const val DAY = 24 * 60 * 60 * 1000L
    }
}
