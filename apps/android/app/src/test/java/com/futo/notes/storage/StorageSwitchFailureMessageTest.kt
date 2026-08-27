package com.futo.notes.storage

import org.junit.Assert.assertEquals
import org.junit.Test

class StorageSwitchFailureMessageTest {
    @Test
    fun `pre-activation failures use the migration message`() {
        val decision = NotesStorage.storageSwitchDecision(
            NotesStorage.MigrationOutcome.Failed("Copy verification failed."),
        )
        val stage = storageSwitchFailureStage(decision)

        assertEquals(StorageSwitchFailureStage.MIGRATION, stage)
        assertEquals("storage.android.migrationFailed", storageSwitchFailureMessage(stage).path)
    }

    @Test
    fun `activation failures use the activation message`() {
        val decision = NotesStorage.storageSwitchDecision(
            NotesStorage.MigrationOutcome.Migrated(files = 2),
        )
        val stage = storageSwitchFailureStage(decision)

        assertEquals(StorageSwitchFailureStage.ACTIVATION, stage)
        assertEquals("storage.android.activationFailed", storageSwitchFailureMessage(stage).path)
    }
}
