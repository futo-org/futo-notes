package com.futo.notes.textfirst

import android.graphics.Color
import android.graphics.Typeface
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import androidx.activity.ComponentActivity
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import com.futo.notes.NotesStore
import com.futo.notes.storage.NotesStorage
import com.futo.notes.localization.LocalLocalization
import com.futo.notes.localization.Localization
import com.futo.notes.flushDraftsForVaultHandoff
import com.futo.notes.rename
import com.futo.notes.migrateVault
import com.futo.notes.tryBeginStorageMigration
import com.futo.notes.resumeAfterStorageMigrationFailure
import com.futo.notes.ui.theme.FutoNotesTheme
import java.io.File
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

/** The actual screen's IME and the vault migration workflow, using only scratch notes. */
class TextFirstMigrationTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test fun migrationCopiesTheVisiblyAcceptedMarkedDraft() = exerciseMigration(failStaging = false)

    @Test fun failedMigrationKeepsTheAcceptedDraftEditableAndRetryable() = exerciseMigration(failStaging = true)

    @Test fun busyAttachmentWriteKeepsOpenPendingWithoutBlockingTheEditorThread() =
        openWhileBusy(closeWhilePending = false)

    @Test fun disposingWhileOpenIsPendingReleasesTheEventualAttachment() =
        openWhileBusy(closeWhilePending = true)

    private fun openWhileBusy(closeWhilePending: Boolean): Unit = runBlocking {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val scratch = File(context.cacheDir, "native-open-migration-${UUID.randomUUID()}").apply { check(mkdirs()) }
        val root = File(scratch, "source").apply { check(mkdirs()) }
        File(root, "draft.md").writeText("exact source")
        lateinit var store: NotesStore
        lateinit var controller: TextFirstController
        compose.runOnUiThread { store = NotesStore(root, File(scratch, "index")) }
        compose.waitUntil(15_000) { store.hasBootstrapped }
        val held = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        val attachment = async {
            store.saveImageIntoVault(
                save = { vault -> File(vault, "pending.png").writeBytes(byteArrayOf(1)); "pending.png" },
                useSavedImage = { held.complete(Unit); release.await() },
            )
        }
        held.await()
        val opened = CompletableDeferred<Throwable?>()
        val font = Typeface.DEFAULT
        val style = TextFirstStyle(1f, 17f, font, font, font, font,
            Color.BLACK, Color.GRAY, Color.BLUE, Color.GRAY, Color.WHITE, Color.WHITE)
        withContext(Dispatchers.Main) {
            controller = TextFirstController(compose.activity, { store.core }, root, style, store)
            compose.activity.setContentView(controller.view)
            controller.open("draft") { opened.complete(it) }
        }
        val leaving = if (closeWhilePending) async(Dispatchers.Main) {
            controller.close().also { controller.dispose() }
        } else null
        try {
            val responsive = CompletableDeferred<Unit>()
            withContext(Dispatchers.Main) {
                assertNull("a pending source has no keyboard connection", controller.view.onCreateInputConnection(EditorInfo()))
                controller.view.engine!!.handler.post { controller.view.post { responsive.complete(Unit) } }
            }
            responsive.await()
            assertFalse("ordinary vault work must leave open pending, not fail it", opened.isCompleted)
            assertFalse("disposal must wait for the pending open", leaving?.isCompleted == true)
            release.complete(Unit)
            attachment.await()
            assertNull(opened.await())
            if (leaving != null) assertNotNull(leaving.await()) else {
                assertEquals("exact source", withContext(Dispatchers.Main) { controller.sourceText() })
                assertNotNull(withContext(Dispatchers.Main) { controller.close() })
                withContext(Dispatchers.Main) { controller.dispose() }
            }
            // A disposed pending open must not leave a live attachment behind.
            withContext(Dispatchers.IO) { store.core.openEditor("draft").use { it.detach() } }
        } finally {
            release.complete(Unit)
            attachment.await()
            withContext(Dispatchers.Main) {
                controller.close()
                controller.dispose()
            }
        }
    }

    /** Ordinary vault work (a sync cycle) merely holding the gate is not a failed save. */
    @Test fun closeWaitsOutOrdinaryVaultWorkInsteadOfReportingASaveFailure(): Unit = runBlocking {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val scratch = File(context.cacheDir, "native-close-busy-${UUID.randomUUID()}").apply { check(mkdirs()) }
        val root = File(scratch, "source").apply { check(mkdirs()) }
        File(root, "draft.md").writeText("before")
        lateinit var store: NotesStore
        lateinit var controller: TextFirstController
        compose.runOnUiThread { store = NotesStore(root, File(scratch, "index")) }
        compose.waitUntil(15_000) { store.hasBootstrapped }
        val font = Typeface.DEFAULT
        withContext(Dispatchers.Main) {
            controller = TextFirstController(compose.activity, { store.core }, root,
                TextFirstStyle(1f, 17f, font, font, font, font,
                    Color.BLACK, Color.GRAY, Color.BLUE, Color.GRAY, Color.WHITE, Color.WHITE), store)
            compose.activity.setContentView(controller.view)
            suspendCancellableCoroutine<Unit> { done -> controller.open("draft") { assertNull(it); done.resume(Unit) } }
        }
        val held = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        val busy = async {
            store.saveImageIntoVault(
                save = { vault -> File(vault, "busy.png").writeBytes(byteArrayOf(1)); "busy.png" },
                useSavedImage = { held.complete(Unit); release.await() },
            )
        }
        try {
            withContext(Dispatchers.Main) {
                val input = checkNotNull(controller.view.onCreateInputConnection(EditorInfo()))
                suspendCancellableCoroutine<Unit> { done -> input.handler!!.post { input.commitText("accepted ", 1); done.resume(Unit) } }
            }
            held.await()
            val closing = async(Dispatchers.Main) { controller.close() }
            kotlinx.coroutines.delay(400)
            assertFalse("close waits for the gate rather than failing", closing.isCompleted)
            release.complete(Unit)
            busy.await()
            assertNotNull("close succeeds once the gate frees", closing.await())
            assertEquals("accepted before\n", File(root, "draft.md").readText())
        } finally {
            release.complete(Unit)
            busy.await()
            withContext(Dispatchers.Main) { controller.dispose() }
            store.core.destroy()
            scratch.deleteRecursively()
        }
    }

    @Test fun checkpointAndDetachDuringMigrationRetainTheDraftUntilRetry() = runBlocking {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val scratch = File(context.cacheDir, "native-close-migration-${UUID.randomUUID()}").apply { check(mkdirs()) }
        val root = File(scratch, "source").apply { check(mkdirs()) }
        File(root, "draft.md").writeText("before")
        lateinit var store: NotesStore
        lateinit var controller: TextFirstController
        compose.runOnUiThread { store = NotesStore(root, File(scratch, "index")) }
        compose.waitUntil(15_000) { store.hasBootstrapped }
        withContext(Dispatchers.Main) {
            val font = Typeface.DEFAULT
            controller = TextFirstController(compose.activity, { store.core }, root,
                TextFirstStyle(1f, 17f, font, font, font, font,
                    Color.BLACK, Color.GRAY, Color.BLUE, Color.GRAY, Color.WHITE, Color.WHITE), store)
            compose.activity.setContentView(controller.view)
            suspendCancellableCoroutine<Unit> { done -> controller.open("draft") { assertNull(it); done.resume(Unit) } }
        }
        suspend fun type(text: String) = withContext(Dispatchers.Main) {
            val input = checkNotNull(controller.view.onCreateInputConnection(EditorInfo()))
            suspendCancellableCoroutine<Unit> { done ->
                input.handler!!.post { input.commitText(text, 1); done.resume(Unit) }
            }
        }
        try {
            type("accepted ")
            assertTrue(withContext(Dispatchers.Main) { store.tryBeginStorageMigration() })
            assertNull(withContext(Dispatchers.Main) { controller.checkpoint() })
            assertNull(withContext(Dispatchers.Main) { controller.close() })
            withContext(Dispatchers.Main) {
                controller.dispose()
                assertTrue("a failed detach retains the vault's draft checkpoint owner", store.nativeEditorDrafts.containsKey(controller))
            }
            assertTrue(controller.opened)
            assertEquals("accepted before", withContext(Dispatchers.Main) { controller.sourceText() })
            assertEquals("before", File(root, "draft.md").readText())
            val destination = File(scratch, "destination")
            withContext(Dispatchers.Main) { store.migrateVault(destination) }
            assertEquals("accepted before\n", File(destination, "draft.md").readText())
            withContext(Dispatchers.Main) { store.resumeAfterStorageMigrationFailure() }
            type("retry ")
            withContext(Dispatchers.Main) {
                assertNotNull(controller.checkpoint())
                store.rename("draft", "renamed")
            }
            var detachedId: String? = null
            controller.onCheckpointed = { _, id -> detachedId = id }
            assertNotNull(withContext(Dispatchers.Main) { controller.close() })
            assertEquals("renamed", detachedId)
            assertEquals("accepted retry before\n", File(root, "renamed.md").readText())
            withContext(Dispatchers.Main) {
                controller.dispose()
                assertFalse("successful terminal disposal releases the draft owner", store.nativeEditorDrafts.containsKey(controller))
            }
        } finally {
            withContext(Dispatchers.Main) {
                store.resumeAfterStorageMigrationFailure()
                if (controller.opened) controller.close()
                controller.dispose()
            }
        }
    }

    @Test fun failedCheckpointAbortsMigrationAndRetainsTheDraftForRetry() =
        exerciseMigration(failStaging = false, failCheckpoint = true)

    private fun exerciseMigration(failStaging: Boolean, failCheckpoint: Boolean = false) = runBlocking {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val scratch = File(context.cacheDir, "native-migration-${UUID.randomUUID()}").apply { check(mkdirs()) }
        val root = File(scratch, "source").apply { check(mkdirs()) }
        File(root, "draft.md").writeText("before")
        val destination = File(scratch, "destination")
        if (failStaging) destination.writeText("unusable destination")
        lateinit var store: NotesStore
        compose.runOnUiThread { store = NotesStore(root, File(scratch, "index")) }
        compose.waitUntil(15_000) { store.hasBootstrapped }
        val localization = Localization.fromGeneratedCatalogs(listOf("en"), "en-US")
        val visible = mutableStateOf(true)
        compose.setContent {
            FutoNotesTheme(darkTheme = false) {
                CompositionLocalProvider(LocalLocalization provides localization) {
                    if (visible.value) TextFirstEditorScreen(store, "draft", false, false, {}, {}, registerLeave = { {} })
                }
            }
        }
        lateinit var editor: TextFirstEditText
        fun find(view: View): TextFirstEditText? = when (view) {
            is TextFirstEditText -> view
            is ViewGroup -> (0 until view.childCount).firstNotNullOfOrNull { find(view.getChildAt(it)) }
            else -> null
        }
        compose.waitUntil(15_000) {
            var ready = false
            compose.runOnUiThread {
                find(compose.activity.window.decorView)?.let {
                    if (it.text.toString().startsWith("before")) { editor = it; ready = true }
                }
            }
            ready
        }
        lateinit var input: InputConnection
        compose.runOnUiThread {
            editor.requestFocus()
            input = checkNotNull(editor.onCreateInputConnection(EditorInfo()))
        }
        val typed = CountDownLatch(1)
        input.handler!!.post { input.setComposingText("accepted ", 1); typed.countDown() }
        assertTrue(typed.await(10, TimeUnit.SECONDS))
        compose.waitUntil(10_000) { editor.text.toString().startsWith("accepted before") }
        try {
            if (failCheckpoint) {
                check(File(root, "draft.md").delete())
                check(File(root, "draft.md").mkdir())
            }
            assertTrue(withContext(Dispatchers.Main) { store.tryBeginStorageMigration() })
            val refused = CountDownLatch(1)
            input.handler!!.post { input.commitText("after latch", 1); refused.countDown() }
            assertTrue("editor thread must remain responsive", refused.await(10, TimeUnit.SECONDS))
            compose.runOnUiThread {
                assertEquals("accepted before", editor.text.toString().removeSuffix(TextFirstEditText.END_SENTINEL))
            }
            val result = runCatching { withContext(Dispatchers.Main) { store.migrateVault(destination) } }
            if (failCheckpoint) {
                assertTrue(result.getOrThrow() is NotesStorage.MigrationOutcome.Failed)
                assertFalse("failed checkpoint must not stage a copy", destination.exists())
                check(File(root, "draft.md").delete())
                File(root, "draft.md").writeText("before")
            } else {
                assertEquals("accepted before\n", File(root, "draft.md").readText())
            }
            if (failStaging || failCheckpoint) {
                if (failStaging) {
                    assertTrue("an unusable destination must fail", result.isFailure)
                    assertEquals("unusable destination", destination.readText())
                }
                withContext(Dispatchers.Main) { store.resumeAfterStorageMigrationFailure() }
                val retry = CountDownLatch(1)
                input.handler!!.post { input.commitText("retry ", 1); retry.countDown() }
                assertTrue(retry.await(10, TimeUnit.SECONDS))
                compose.waitUntil(10_000) { editor.text.toString().startsWith("accepted retry before") }
                withContext(Dispatchers.Main) {
                    assertTrue(store.tryBeginStorageMigration())
                    assertTrue(store.flushDraftsForVaultHandoff())
                }
                assertEquals("accepted retry before\n", File(root, "draft.md").readText())
            } else {
                result.getOrThrow()
                assertEquals("accepted before\n", File(destination, "draft.md").readText())
            }
        } finally {
            // Successful staging keeps the source authoritative until activation.
            withContext(Dispatchers.Main) { store.resumeAfterStorageMigrationFailure() }
            compose.runOnUiThread { visible.value = false }
            compose.waitForIdle()
        }
    }
}
