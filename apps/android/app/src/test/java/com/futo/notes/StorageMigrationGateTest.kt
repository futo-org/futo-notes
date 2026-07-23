package com.futo.notes

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
