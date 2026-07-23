package com.futo.notes.storage

import android.system.Os
import android.system.OsConstants
import java.io.File
import java.io.FileOutputStream

enum class StorageMigrationPhase { PREPARED, FINALIZING, ACTIVATED }

data class PendingStorageMigration(
    val from: StorageMode,
    val to: StorageMode,
    val phase: StorageMigrationPhase,
    val cleanupRequired: Boolean,
)

/**
 * Crash-safe authority for an in-progress storage switch.
 *
 * SharedPreferences remains the normal cached setting, but its commit result is
 * ambiguous after a disk failure. This small app-private file is fsynced and
 * atomically replaced so startup can choose one authoritative root.
 */
internal class StorageMigrationJournal(
    private val file: File,
    private val replaceFile: (File, File) -> Unit = ::replaceJournalFile,
    private val syncDirectory: (File?) -> Unit = ::fsyncDirectory,
) {
    fun read(): Result<PendingStorageMigration?> = runCatching {
        if (!file.exists()) return@runCatching null
        decodeStorageMigrationJournal(file.readText())
    }

    fun write(record: PendingStorageMigration): Result<Unit> = runCatching {
        file.parentFile?.mkdirs()
        val pending = File(file.parentFile, "${file.name}.pending")
        try {
            FileOutputStream(pending).use { output ->
                output.write(encodeStorageMigrationJournal(record).toByteArray(Charsets.UTF_8))
                output.fd.sync()
            }
            replaceFile(pending, file)
            syncDirectory(file.parentFile)
        } finally {
            if (pending.exists()) pending.delete()
        }
    }

    fun clear(): Result<Unit> = runCatching {
        if (file.exists() && !file.delete()) {
            error("Could not clear the storage migration journal")
        }
        syncDirectory(file.parentFile)
        Unit
    }
}

private fun replaceJournalFile(source: File, destination: File) {
    Os.rename(source.absolutePath, destination.absolutePath)
}

private fun fsyncDirectory(directory: File?) {
    if (directory == null) return
    val descriptor = Os.open(directory.absolutePath, OsConstants.O_RDONLY, 0)
    try {
        Os.fsync(descriptor)
    } finally {
        Os.close(descriptor)
    }
}

internal fun encodeStorageMigrationJournal(record: PendingStorageMigration): String =
    listOf(
        "FUTO_STORAGE_MIGRATION_V1",
        record.phase.name,
        record.from.name,
        record.to.name,
        record.cleanupRequired.toString(),
    ).joinToString("\n", postfix = "\n")

internal fun decodeStorageMigrationJournal(raw: String): PendingStorageMigration {
    val lines = raw.lineSequence().filter { it.isNotEmpty() }.toList()
    require(lines.size == 5 && lines[0] == "FUTO_STORAGE_MIGRATION_V1") {
        "The storage migration journal is invalid"
    }
    return PendingStorageMigration(
        phase = StorageMigrationPhase.valueOf(lines[1]),
        from = StorageMode.valueOf(lines[2]),
        to = StorageMode.valueOf(lines[3]),
        cleanupRequired = lines[4].toBooleanStrict(),
    )
}
