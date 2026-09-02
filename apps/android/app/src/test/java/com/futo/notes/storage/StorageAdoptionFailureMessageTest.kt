package com.futo.notes.storage

import org.junit.Assert.assertEquals
import org.junit.Test

class StorageAdoptionFailureMessageTest {
    @Test
    fun `every adoption failure keeps a distinct semantic message`() {
        assertEquals(
            "storage.android.disconnectSyncFirst",
            storageAdoptionFailureMessage(StorageAdoptionFailure.SYNC_CONNECTED).path,
        )
        assertEquals(
            "storage.android.adoptionSaveFailed",
            storageAdoptionFailureMessage(StorageAdoptionFailure.DRAFT_FLUSH_FAILED).path,
        )
        assertEquals(
            "storage.android.adoptionRecordFailed",
            storageAdoptionFailureMessage(StorageAdoptionFailure.JOURNAL_CLEAR_FAILED).path,
        )
        assertEquals(
            "storage.android.adoptionPreferenceFailed",
            storageAdoptionFailureMessage(StorageAdoptionFailure.PREFERENCE_SAVE_FAILED).path,
        )
        assertEquals(
            StorageAdoptionFailure.entries.size,
            StorageAdoptionFailure.entries.map { storageAdoptionFailureMessage(it).path }.toSet().size,
        )
    }

    @Test
    fun `every refusal reason keeps a distinct semantic message`() {
        assertEquals(
            "storage.android.folderUnavailable",
            storageRefusalMessage(StorageRefusalReason.DESTINATION_UNUSABLE).path,
        )
        assertEquals(
            "storage.android.disconnectSyncFirst",
            storageRefusalMessage(StorageRefusalReason.SYNC_CONNECTED).path,
        )
    }
}
