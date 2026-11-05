package com.futo.notes.textfirst

import androidx.test.platform.app.InstrumentationRegistry
import com.futo.notes.NotesStore
import com.futo.notes.tryBeginStorageMigration
import com.futo.notes.resumeAfterStorageMigrationFailure
import java.io.File
import java.util.UUID
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import org.junit.Assert.*
import org.junit.Test
import uniffi.futo_notes_ffi.RenamePair
import uniffi.futo_notes_ffi.SyncSummary

/** Shell delivery retries explicit identity intent instead of mistaking a rescan for adoption. */
class TextFirstExternalRefreshTest {
    @get:org.junit.Rule val compose = androidx.compose.ui.test.junit4.createAndroidComposeRule<androidx.activity.ComponentActivity>()
    @Test
    fun migrationAdmissionRetainsCleanExternalReconciliationForRetry() = runBlocking {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val scratch = File(context.cacheDir, "refresh-gate-${UUID.randomUUID()}").apply { check(mkdirs()) }
        val root = File(scratch, "vault").apply { check(mkdirs()) }
        File(root, "draft.md").writeText("base")
        val store = withContext(Dispatchers.Main) { NotesStore(root, File(scratch, "index")) }
        compose.waitUntil(10_000) { store.hasBootstrapped }
        lateinit var controller: TextFirstController
        val saved = kotlinx.coroutines.CompletableDeferred<Unit>()
        try {
            withContext(Dispatchers.Main) {
                val font = android.graphics.Typeface.DEFAULT
                controller = TextFirstController(compose.activity, { store.core }, root,
                    TextFirstStyle(1f, 17f, font, font, font, font,
                        android.graphics.Color.BLACK, android.graphics.Color.GRAY, android.graphics.Color.BLUE,
                        android.graphics.Color.GRAY, android.graphics.Color.WHITE, android.graphics.Color.WHITE), store)
                compose.activity.setContentView(controller.view)
                kotlinx.coroutines.suspendCancellableCoroutine<Unit> { done ->
                    controller.open("draft") { assertNull(it); done.resumeWith(Result.success(Unit)) }
                }
                File(root, "draft.md").writeText("peer base")
                store.core.refreshExternalChanges(listOf("draft"), emptyList(), emptyList())
                assertTrue(store.tryBeginStorageMigration())
                controller.onCheckpointed = { _, _ -> saved.complete(Unit) }
                controller.reconcileExternalChanges()
                assertEquals("base", controller.sourceText())
                store.resumeAfterStorageMigrationFailure()
            }
            withTimeout(5_000) { saved.await() }
            assertEquals("peer base", withContext(Dispatchers.Main) { controller.sourceText() })
        } finally {
            withContext(Dispatchers.Main) {
                store.resumeAfterStorageMigrationFailure()
                controller.discard(); controller.dispose()
            }
            store.scope.coroutineContext[kotlinx.coroutines.Job]?.cancel()
            store.core.destroy()
            scratch.deleteRecursively()
        }
    }

    @Test
    fun refusedDestinationKeepsEventUntilAttachmentCanFollow() = runBlocking {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val scratch = File(context.cacheDir, "refresh-${UUID.randomUUID()}").apply { check(mkdirs()) }
        val root = File(scratch, "vault").apply { check(mkdirs()) }
        File(root, "old.md").writeText("base\n")
        val store = withContext(Dispatchers.Main) { NotesStore(root, File(scratch, "index")) }
        val events = Channel<SyncSummary>(Channel.UNLIMITED)
        val collector = launch(start = CoroutineStart.UNDISPATCHED) { store.localTreeChanges.collect { events.send(it) } }
        try {
            compose.waitUntil(10_000) { store.hasBootstrapped }
            store.core.openEditor("old").use { attached ->
                attached.replaceUtf16(0uL, uniffi.futo_notes_ffi.EditorUtf16Range(0uL, 0uL), "local ".map { it.code.toUShort() })
                check(File(root, "old.md").renameTo(File(root, "new.md")))
                store.core.openEditor("new").use { blocker ->
                    withContext(Dispatchers.Main) {
                        store.localTreeChanged(SyncSummary(
                            uploaded = 0u, downloaded = 1u, deleted = 0u, conflicts = 0u,
                            localWritesApplied = 1u, failures = emptyList(), failureMessage = null,
                            updatedIds = listOf("new"), deletedIds = listOf("old"),
                            peerUpdatedIds = listOf("new"), peerDeletedIds = listOf("old"),
                            renamed = listOf(RenamePair("old", "new")), writeRefusal = null,
                        ))
                    }
                    assertNull("unsuccessful refresh cannot publish authoritative rename", withTimeoutOrNull(500) { events.receive() })
                    assertEquals("old", attached.noteId())
                    blocker.detach()
                }
                val event = withTimeout(10_000) { events.receive() }
                assertEquals(listOf(RenamePair("old", "new")), event.renamed)
                assertEquals("new", attached.noteId())
                assertEquals("local base\n", attached.sourceText())
                attached.detach()
                assertFalse(File(root, "old.md").exists())
                assertEquals("local base\n", store.core.read("new"))
            }
        } finally {
            collector.cancel()
            store.scope.coroutineContext[kotlinx.coroutines.Job]?.cancel()
            store.core.destroy()
            scratch.deleteRecursively()
        }
    }
}
