package com.futo.notes.storage

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import uniffi.futo_notes_ffi.VaultMigrationFinalization

class StorageMigrationActivationTest {
    private val prepared = PendingStorageMigration(
        from = StorageMode.APP,
        to = StorageMode.DEVICE,
        phase = StorageMigrationPhase.PREPARED,
        cleanupRequired = false,
    )

    @Test
    fun `changed destination never reaches activated journal`() = runBlocking {
        val records = mutableListOf<PendingStorageMigration>()

        val outcome = activateStagedStorageMigration(
            prepared = prepared,
            decision = NotesStorage.storageSwitchDecision(
                NotesStorage.MigrationOutcome.Migrated(2)
            ),
            writeJournal = { records.add(it); true },
            finalizeSource = { VaultMigrationFinalization.DESTINATION_CHANGED },
            commitPreference = { error("preference must not be committed") },
            clearJournal = {},
        )

        assertTrue(outcome is StorageActivationOutcome.KeepSource)
        assertEquals(listOf(StorageMigrationPhase.FINALIZING), records.map { it.phase })
    }

    @Test
    fun `journal failure after source cleanup restarts for recovery`() = runBlocking {
        var writes = 0

        val outcome = activateStagedStorageMigration(
            prepared = prepared,
            decision = NotesStorage.storageSwitchDecision(
                NotesStorage.MigrationOutcome.Migrated(2)
            ),
            writeJournal = { ++writes == 1 },
            finalizeSource = { VaultMigrationFinalization.FINALIZED },
            commitPreference = { error("preference must not be committed") },
            clearJournal = {},
        )

        assertEquals(StorageActivationOutcome.Restart, outcome)
    }

    @Test
    fun `journal failure after retained source restarts with a recoverable journal`() = runBlocking {
        val records = mutableListOf<PendingStorageMigration>()
        val retainedSource = prepared.copy(
            from = StorageMode.DEVICE,
            to = StorageMode.APP,
        )

        val outcome = activateStagedStorageMigration(
            prepared = retainedSource,
            decision = NotesStorage.storageSwitchDecision(
                NotesStorage.MigrationOutcome.Migrated(2)
            ),
            writeJournal = { record ->
                records += record
                records.size == 1
            },
            finalizeSource = { VaultMigrationFinalization.SOURCE_RETAINED },
            commitPreference = { error("preference must not be committed") },
            clearJournal = {},
        )

        assertEquals(StorageActivationOutcome.Restart, outcome)
        assertEquals(
            listOf(StorageMigrationPhase.FINALIZING, StorageMigrationPhase.ACTIVATED),
            records.map { it.phase },
        )
        assertFalse(records.first().cleanupRequired)
        assertTrue(records.first().sourceRemovalForbidden)
        assertTrue(records.last().cleanupRequired)
        assertTrue(records.last().sourceRemovalForbidden)
    }

    @Test
    fun `activated journal remains authoritative when preference commit fails`() = runBlocking {
        val records = mutableListOf<PendingStorageMigration>()
        var cleared = false

        val outcome = activateStagedStorageMigration(
            prepared = prepared,
            decision = NotesStorage.storageSwitchDecision(
                NotesStorage.MigrationOutcome.AlreadyAtDestination
            ),
            writeJournal = { records.add(it); true },
            finalizeSource = { error("no finalization expected") },
            commitPreference = { false },
            clearJournal = { cleared = true },
        )

        assertEquals(StorageActivationOutcome.Restart, outcome)
        assertEquals(listOf(StorageMigrationPhase.ACTIVATED), records.map { it.phase })
        assertFalse(cleared)
    }
}
