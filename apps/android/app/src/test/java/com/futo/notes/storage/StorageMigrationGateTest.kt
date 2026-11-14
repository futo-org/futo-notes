package com.futo.notes.storage

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class StorageMigrationGateTest {
    @Test
    fun `editor access never waits on the migration that drains its thread`() = runBlocking {
        val gate = StorageMigrationGate()
        var writes = 0
        assertEquals(GateAccess.RAN, gate.tryRunAccess { writes++ })
        gate.beginMigration()
        gate.runMigration {
            assertEquals(GateAccess.PAUSED, gate.tryRunAccess { writes++ })
        }
        assertEquals(1, writes)
        gate.resume()
        assertEquals(GateAccess.RAN, gate.tryRunAccess { writes++ })
        assertEquals(2, writes)
    }

    @Test
    fun `a gate held by ordinary work reads as busy, not as a refused operation`() = runBlocking {
        val gate = StorageMigrationGate()
        val held = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        val work = launch { gate.runAccess { held.complete(Unit); release.await() } }
        held.await()
        var writes = 0
        assertEquals(GateAccess.BUSY, gate.tryRunAccess { writes++ })
        gate.beginMigration()
        assertEquals("migration latched while held is a pause, not contention", GateAccess.PAUSED, gate.tryRunAccess { writes++ })
        release.complete(Unit)
        work.join()
        assertEquals(0, writes)
    }

    @Test
    fun `migration drains an in-flight write before it starts`() = runBlocking {
        val gate = StorageMigrationGate()
        val writeStarted = CompletableDeferred<Unit>()
        val releaseWrite = CompletableDeferred<Unit>()
        val order = mutableListOf<String>()

        val write = launch {
            gate.runAccess {
                writeStarted.complete(Unit)
                releaseWrite.await()
                order += "write"
            }
        }
        writeStarted.await()

        gate.beginMigration()
        val migration = launch {
            gate.runMigration {
                order += "migration"
            }
        }
        assertTrue(order.isEmpty())

        releaseWrite.complete(Unit)
        write.join()
        migration.join()

        assertEquals(listOf("write", "migration"), order)
    }

    @Test
    fun `new work is rejected as soon as migration begins`() = runBlocking {
        val gate = StorageMigrationGate()
        gate.beginMigration()

        val optionalAccess = async {
            gate.runAccessIfAvailable { "started" }
        }

        assertNull(optionalAccess.await())
    }

    @Test
    fun `idle-only migration refuses the post-write callback inside gated access`() = runBlocking {
        val gate = StorageMigrationGate()
        val fileWriteFinished = CompletableDeferred<Unit>()
        val releaseEditorCallback = CompletableDeferred<Unit>()

        val write = launch {
            gate.runAccess {
                fileWriteFinished.complete(Unit)
                releaseEditorCallback.await()
            }
        }
        fileWriteFinished.await()

        assertEquals(false, gate.tryBeginMigrationWhenIdle())

        releaseEditorCallback.complete(Unit)
        write.join()
        assertEquals("available", gate.runAccess { "available" })
    }
}
