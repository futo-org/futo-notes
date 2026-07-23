package com.futo.notes

import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * Serializes one storage-root consumer with migration. Migration begins
 * synchronously so newly queued work is rejected while [runMigration] drains
 * any operation that was already in flight.
 */
internal class StorageMigrationGate {
    private val mutex = Mutex()

    @Volatile
    private var migrationStarted = false

    val isMigrationStarted: Boolean
        get() = migrationStarted

    fun beginMigration() {
        migrationStarted = true
    }

    fun resume() {
        migrationStarted = false
    }

    suspend fun <T> runAccess(block: suspend () -> T): T =
        mutex.withLock {
            check(!migrationStarted) { "Storage access is paused for migration" }
            block()
        }

    suspend fun <T> runAccessIfAvailable(block: suspend () -> T): T? =
        mutex.withLock {
            if (migrationStarted) null else block()
        }

    suspend fun <T> runMigration(block: suspend () -> T): T =
        mutex.withLock {
            check(migrationStarted) { "Storage migration has not started" }
            block()
        }
}
