package com.futo.notes.storage

import org.junit.Assert.assertEquals
import org.junit.Test

class StorageMigrationRecoveryMessageTest {
    @Test
    fun `recovery failures keep distinct semantic messages`() {
        assertEquals(
            "storage.android.recoveryFailed",
            storageRecoveryMessage(StorageRecoveryFailure.GENERIC_FAILURE).path,
        )
        assertEquals(
            "storage.android.recoverySourceUnavailable",
            storageRecoveryMessage(StorageRecoveryFailure.SOURCE_UNAVAILABLE).path,
        )
        assertEquals(
            "storage.android.recoverySaveFailed",
            storageRecoveryMessage(StorageRecoveryFailure.PREFERENCE_SAVE_FAILED).path,
        )
        assertEquals(
            "storage.android.recoveryRecordFailed",
            storageRecoveryMessage(StorageRecoveryFailure.JOURNAL_UPDATE_FAILED).path,
        )
    }
}
