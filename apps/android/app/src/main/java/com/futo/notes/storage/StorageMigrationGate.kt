package com.futo.notes.storage

import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/** Outcome of a non-waiting [StorageMigrationGate.tryRunAccess]. */
internal enum class GateAccess { RAN, BUSY, PAUSED }

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

    /** Atomically latch migration only when no access is in flight. Providers
     * whose operation completes with a later UI callback use this form so the
     * callback cannot land after migration starts. */
    fun tryBeginMigrationWhenIdle(): Boolean {
        if (!mutex.tryLock()) return false
        return try {
            migrationStarted = true
            true
        } finally {
            mutex.unlock()
        }
    }

    /** Editor-thread access never waits: migration drains that same thread
     * while holding this gate, so waiting here would invert the lock order.
     * [GateAccess.BUSY] (another consumer holds the gate) is transient, while
     * [GateAccess.PAUSED] (migration has begun) is not; callers must not mistake
     * the first for a failed operation. */
    fun tryRunAccess(block: () -> Unit): GateAccess {
        if (!mutex.tryLock()) return if (migrationStarted) GateAccess.PAUSED else GateAccess.BUSY
        return try {
            if (migrationStarted) GateAccess.PAUSED else { block(); GateAccess.RAN }
        } finally {
            mutex.unlock()
        }
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
