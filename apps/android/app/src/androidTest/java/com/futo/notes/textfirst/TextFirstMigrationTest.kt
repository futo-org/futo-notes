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
import com.futo.notes.migrateVault
import com.futo.notes.tryBeginStorageMigration
import com.futo.notes.resumeAfterStorageMigrationFailure
import com.futo.notes.ui.theme.FutoNotesTheme
import java.io.File
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
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
            assertTrue(controller.opened)
            assertEquals("accepted before", withContext(Dispatchers.Main) { controller.sourceText() })
            assertEquals("before", File(root, "draft.md").readText())
            val destination = File(scratch, "destination")
            withContext(Dispatchers.Main) { store.migrateVault(destination) }
            assertEquals("accepted before", File(destination, "draft.md").readText())
            withContext(Dispatchers.Main) { store.resumeAfterStorageMigrationFailure() }
            type("retry ")
            assertNotNull(withContext(Dispatchers.Main) { controller.close() })
            assertEquals("accepted retry before", File(root, "draft.md").readText())
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
                    if (visible.value) TextFirstEditorScreen(store, "draft", false, false, {}, registerLeave = { {} })
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
            compose.runOnUiThread { assertTrue(editor.text.toString().startsWith("accepted before")) }
            val result = runCatching { withContext(Dispatchers.Main) { store.migrateVault(destination) } }
            if (failCheckpoint) {
                assertTrue(result.getOrThrow() is NotesStorage.MigrationOutcome.Failed)
                assertFalse("failed checkpoint must not stage a copy", destination.exists())
                check(File(root, "draft.md").delete())
                File(root, "draft.md").writeText("before")
            } else {
                assertEquals("accepted before", File(root, "draft.md").readText())
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
                assertEquals("accepted retry before", File(root, "draft.md").readText())
            } else {
                result.getOrThrow()
                assertEquals("accepted before", File(destination, "draft.md").readText())
            }
        } finally {
            // Successful staging keeps the source authoritative until activation.
            withContext(Dispatchers.Main) { store.resumeAfterStorageMigrationFailure() }
            compose.runOnUiThread { visible.value = false }
            compose.waitForIdle()
        }
    }
}
