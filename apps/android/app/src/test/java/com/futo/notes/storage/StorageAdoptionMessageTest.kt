package com.futo.notes.storage

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test

class StorageAdoptionMessageTest {
    private val currentTimeMillis = 1_700_000_000_000L

    private fun summary(
        destinationNotes: Int = 3,
        destinationLastModifiedMillis: Long = currentTimeMillis - 3 * MILLISECONDS_PER_DAY,
        currentNotes: Int = 14,
    ) = StorageAdoptionSummary(
        destinationNotes = destinationNotes,
        destinationLastModifiedMillis = destinationLastModifiedMillis,
        currentPath = "/storage/emulated/0/Android/data/com.futo.notes/files/futo-notes",
        currentNotes = currentNotes,
        currentTimeMillis = currentTimeMillis,
    )

    @Test
    fun carriesBothFolderDetails() {
        val message = storageAdoptionMessage(summary()) { "3 days ago" }
        assertEquals(3, message.arguments["destinationNotes"])
        assertEquals(14, message.arguments["currentNotes"])
        assertEquals(
            "/storage/emulated/0/Android/data/com.futo.notes/files/futo-notes",
            message.arguments["currentPath"],
        )
    }

    @Test
    fun usesSharedRelativeTimeForKnownModificationTime() {
        val destinationLastModifiedMillis = currentTimeMillis - 3 * MILLISECONDS_PER_DAY
        var formattedTimestamp: Long? = null
        val message = storageAdoptionMessage(
            summary(destinationLastModifiedMillis = destinationLastModifiedMillis),
        ) { timestamp ->
            formattedTimestamp = timestamp
            "3 days ago"
        }

        assertEquals(destinationLastModifiedMillis, formattedTimestamp)
        assertEquals("storage.android.adoptionWithLastChanged", message.path)
        assertEquals("3 days ago", message.arguments["lastChanged"])
    }

    @Test
    fun omitsAnUnknownOrFutureModificationTime() {
        val unusableModificationTimes = listOf(0L, currentTimeMillis + 5 * MILLISECONDS_PER_DAY)
        for (destinationLastModifiedMillis in unusableModificationTimes) {
            var relativeTimeWasFormatted = false
            val message = storageAdoptionMessage(
                summary(destinationLastModifiedMillis = destinationLastModifiedMillis),
            ) {
                relativeTimeWasFormatted = true
                "unused"
            }

            assertEquals("storage.android.adoption", message.path)
            assertFalse(relativeTimeWasFormatted)
            assertNull(message.arguments["lastChanged"])
        }
    }

    @Test
    fun usesGeneralAdoptionMessageForNoNotes() {
        var relativeTimeWasFormatted = false
        val message = storageAdoptionMessage(
            summary(destinationNotes = 0),
        ) {
            relativeTimeWasFormatted = true
            "unused"
        }

        assertEquals("storage.android.adoption", message.path)
        assertFalse(relativeTimeWasFormatted)
        assertEquals(
            0,
            message.arguments["destinationNotes"],
        )
    }

    private companion object {
        const val MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000L
    }
}
