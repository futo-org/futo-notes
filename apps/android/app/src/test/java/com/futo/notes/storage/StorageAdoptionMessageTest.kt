package com.futo.notes.storage

import org.junit.Assert.assertEquals
import org.junit.Test

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
    fun carriesBothFoldersWithoutPretranslatingThem() {
        val message = storageAdoptionMessage(summary())
        assertEquals(3, message.arguments["destinationNotes"])
        assertEquals(14, message.arguments["currentNotes"])
        assertEquals(
            "/storage/emulated/0/Android/data/com.futo.notes/files/futo-notes",
            message.arguments["currentPath"],
        )
    }

    @Test
    fun selectsTheDestinationAgeMessage() {
        assertEquals("storage.android.adoptionWithNotesDaysAgo", storageAdoptionMessage(summary()).path)
        assertEquals(
            "storage.android.adoptionWithNotesToday",
            storageAdoptionMessage(summary(destinationLastModifiedMs = now)).path,
        )
        assertEquals(
            "storage.android.adoptionWithNotesYesterday",
            storageAdoptionMessage(summary(destinationLastModifiedMs = now - DAY)).path,
        )
        assertEquals(
            "storage.android.adoptionWithNotesOverMonth",
            storageAdoptionMessage(summary(destinationLastModifiedMs = now - 400 * DAY)).path,
        )
    }

    @Test
    fun omitsAnUnknownOrFutureAge() {
        assertEquals(
            "storage.android.adoptionWithNotes",
            storageAdoptionMessage(summary(destinationLastModifiedMs = 0)).path,
        )
        assertEquals(
            "storage.android.adoptionWithNotes",
            storageAdoptionMessage(summary(destinationLastModifiedMs = now + 5 * DAY)).path,
        )
    }

    @Test
    fun selectsTheNoNotesMessage() {
        assertEquals(
            "storage.android.adoptionNoNotes",
            storageAdoptionMessage(summary(destinationNotes = 0)).path,
        )
    }

    private companion object {
        const val DAY = 24 * 60 * 60 * 1000L
    }
}
