package com.futo.notes

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
        )

        journal(file).write(record).getOrThrow()

        assertEquals(record, journal(file).read().getOrThrow())
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
    fun `corrupt journal fails closed`() {
        val file = File(tmp.root, "migration")
        file.writeText("not a journal")

        assertTrue(journal(file).read().isFailure)
    }
}
