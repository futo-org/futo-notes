package com.futo.notes

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.util.UUID
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import uniffi.futo_notes_ffi.RenamePair
import uniffi.futo_notes_ffi.SyncSummary

/** The post-sync list refresh is shared by the WebView editor; a refresh that can never succeed must not stall it. */
class NotesStoreLocalTreeTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    private fun summary(updated: List<String>, renamed: List<RenamePair> = emptyList()) = SyncSummary(
        uploaded = 0u, downloaded = updated.size.toUInt(), deleted = 0u, conflicts = 0u,
        localWritesApplied = 1u, failures = emptyList(), failureMessage = null,
        updatedIds = updated, deletedIds = emptyList(), peerUpdatedIds = updated, peerDeletedIds = emptyList(),
        renamed = renamed, writeRefusal = null,
    )

    @Test
    fun aPersistentlyRefusedRefreshRescansAndLaterSyncsStillProject() = runBlocking {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val scratch = File(context.cacheDir, "local-tree-${UUID.randomUUID()}").apply { check(mkdirs()) }
        val root = File(scratch, "vault").apply { check(mkdirs()) }
        File(root, "seed.md").writeText("seed")
        val store = withContext(Dispatchers.Main) { NotesStore(root, File(scratch, "index")) }
        val events = Channel<SyncSummary>(Channel.UNLIMITED)
        val collector = launch(start = CoroutineStart.UNDISPATCHED) { store.localTreeChanges.collect { events.send(it) } }
        try {
            compose.waitUntil(15_000) { store.hasBootstrapped }
            store.localTreeRetry = LocalTreeRetry(attempts = 2, delayMs = 20)

            File(root, "first.md").writeText("first")
            // An id outside the vault can never be refreshed, however often it is retried.
            val poisoned = summary(listOf("first"), listOf(RenamePair("../escape", "first")))
            withContext(Dispatchers.Main) { store.localTreeChanged(poisoned) }
            assertEquals(poisoned, withTimeout(5_000) { events.receive() })
            assertTrue("rescan fallback recovers the list", store.notes.any { it.id == "first" })

            File(root, "second.md").writeText("second")
            val later = summary(listOf("second"))
            withContext(Dispatchers.Main) { store.localTreeChanged(later) }
            assertEquals(later, withTimeout(5_000) { events.receive() })
            assertTrue("a later sync is not stalled", store.notes.any { it.id == "second" })
        } finally {
            collector.cancel()
            store.scope.coroutineContext[kotlinx.coroutines.Job]?.cancel()
            store.core.destroy()
            scratch.deleteRecursively()
        }
    }
}
