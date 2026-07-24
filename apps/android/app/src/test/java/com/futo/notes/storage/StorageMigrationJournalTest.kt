package com.futo.notes.storage

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

class StorageMigrationJournalTest {
    @get:Rule
    val tmp = TemporaryFolder()

    private fun journal(file: File): StorageMigrationJournal =
        StorageMigrationJournal(
            file = file,
            replaceFile = { source, destination ->
                if (destination.exists()) check(destination.delete())
                check(source.renameTo(destination))
            },
            syncDirectory = {},
        )

    @Test
    fun `journal round trips across instances`() {
        val file = File(tmp.root, "migration")
        val record = PendingStorageMigration(
            from = StorageMode.INTERNAL,
            to = StorageMode.DEVICE,
            phase = StorageMigrationPhase.ACTIVATED,
            cleanupRequired = true,
            sourceRemovalForbidden = true,
        )

        journal(file).write(record).getOrThrow()

        assertEquals(record, journal(file).read().getOrThrow())
        assertTrue(file.readText().startsWith("FUTO_STORAGE_MIGRATION_V2\n"))
    }

    @Test
    fun `version one journal decodes without a source-removal restriction`() {
        val record = decodeStorageMigrationJournal(
            """
            FUTO_STORAGE_MIGRATION_V1
            ACTIVATED
            INTERNAL
            DEVICE
            true
            """.trimIndent() + "\n"
        )

        assertEquals(StorageMigrationPhase.ACTIVATED, record.phase)
        assertTrue(record.cleanupRequired)
        assertEquals(false, record.sourceRemovalForbidden)
    }

    @Test
    fun `prepared journal keeps old root even when preference says new`() {
        val pending = PendingStorageMigration(
            from = StorageMode.APP,
            to = StorageMode.DEVICE,
            phase = StorageMigrationPhase.PREPARED,
            cleanupRequired = false,
        )

        val decision = NotesStorage.storageRecoveryDecision(StorageMode.DEVICE.name, pending)

        assertEquals(StorageMode.APP, decision.activeMode)
        assertEquals(StorageMode.APP, decision.repairPreferenceTo)
    }

    @Test
    fun `activated journal selects new root and repairs stale preference`() {
        val pending = PendingStorageMigration(
            from = StorageMode.APP,
            to = StorageMode.DEVICE,
            phase = StorageMigrationPhase.ACTIVATED,
            cleanupRequired = true,
        )

        val decision = NotesStorage.storageRecoveryDecision(StorageMode.APP.name, pending)

        assertEquals(StorageMode.DEVICE, decision.activeMode)
        assertEquals(StorageMode.DEVICE, decision.repairPreferenceTo)
    }

    @Test
    fun `finalizing journal selects destination only after source removal`() {
        val pending = PendingStorageMigration(
            from = StorageMode.APP,
            to = StorageMode.DEVICE,
            phase = StorageMigrationPhase.FINALIZING,
            cleanupRequired = false,
        )

        val decision = NotesStorage.storageRecoveryDecision(
            StorageMode.APP.name,
            pending,
            sourceState = StorageRootState.ABSENT,
        )

        assertEquals(StorageMode.DEVICE, decision.activeMode)
        assertEquals(StorageMode.DEVICE, decision.repairPreferenceTo)
    }

    @Test
    fun `finalizing retained-source journal rolls back to a present source`() {
        val pending = PendingStorageMigration(
            from = StorageMode.DEVICE,
            to = StorageMode.APP,
            phase = StorageMigrationPhase.FINALIZING,
            cleanupRequired = false,
            sourceRemovalForbidden = true,
        )

        val decision = NotesStorage.storageRecoveryDecision(
            StorageMode.APP.name,
            pending,
            sourceState = StorageRootState.PRESENT,
        )

        assertEquals(StorageMode.DEVICE, decision.activeMode)
        assertEquals(StorageMode.DEVICE, decision.repairPreferenceTo)
    }

    @Test(expected = IllegalStateException::class)
    fun `finalizing journal refuses to guess while source remains`() {
        NotesStorage.storageRecoveryDecision(
            savedMode = StorageMode.APP.name,
            pending = PendingStorageMigration(
                from = StorageMode.APP,
                to = StorageMode.DEVICE,
                phase = StorageMigrationPhase.FINALIZING,
                cleanupRequired = false,
            ),
            sourceState = StorageRootState.PRESENT,
        )
    }

    @Test(expected = IllegalStateException::class)
    fun `finalizing journal refuses to treat unavailable storage as removed`() {
        NotesStorage.storageRecoveryDecision(
            savedMode = StorageMode.APP.name,
            pending = PendingStorageMigration(
                from = StorageMode.DEVICE,
                to = StorageMode.APP,
                phase = StorageMigrationPhase.FINALIZING,
                cleanupRequired = false,
            ),
            sourceState = StorageRootState.UNAVAILABLE,
        )
    }

    @Test
    fun `corrupt journal fails closed`() {
        val file = File(tmp.root, "migration")
        file.writeText("not a journal")

        assertTrue(journal(file).read().isFailure)
    }
}
