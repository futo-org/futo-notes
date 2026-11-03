package com.futo.notes.textfirst

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
import com.futo.notes.localization.LocalLocalization
import com.futo.notes.localization.Localization
import com.futo.notes.migrateVault
import com.futo.notes.tryBeginStorageMigration
import com.futo.notes.ui.theme.FutoNotesTheme
import java.io.File
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

/** The actual screen's IME and the vault migration workflow, using only scratch notes. */
class TextFirstMigrationTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test fun migrationCopiesTheVisiblyAcceptedMarkedDraft() = runBlocking {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val scratch = File(context.cacheDir, "native-migration-${UUID.randomUUID()}").apply { check(mkdirs()) }
        val root = File(scratch, "source").apply { check(mkdirs()) }
        File(root, "draft.md").writeText("before")
        val destination = File(scratch, "destination")
        lateinit var store: NotesStore
        compose.runOnUiThread { store = NotesStore(root, File(scratch, "index")) }
        compose.waitUntil(15_000) { store.hasBootstrapped }
        val localization = Localization.fromGeneratedCatalogs(listOf("en"), "en-US")
        val visible = mutableStateOf(true)
        compose.setContent {
            FutoNotesTheme(darkTheme = false) {
                CompositionLocalProvider(LocalLocalization provides localization) {
                    if (visible.value) TextFirstEditorScreen(store, "draft", false, false, {})
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
            assertTrue(withContext(Dispatchers.Main) { store.tryBeginStorageMigration() })
            val refused = CountDownLatch(1)
            input.handler!!.post { input.commitText("after latch", 1); refused.countDown() }
            assertTrue("editor thread must remain responsive", refused.await(10, TimeUnit.SECONDS))
            compose.runOnUiThread { assertTrue(editor.text.toString().startsWith("accepted before")) }
            withContext(Dispatchers.Main) { store.migrateVault(destination) }
            assertEquals("accepted before", File(destination, "draft.md").readText())
            assertEquals("accepted before", File(root, "draft.md").readText())
        } finally {
            // Successful staging keeps the source authoritative until activation.
            withContext(Dispatchers.Main) { store.storageMigrationGate.resume() }
            compose.runOnUiThread { visible.value = false }
            compose.waitForIdle()
        }
    }
}
