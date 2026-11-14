package com.futo.notes.textfirst

import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import androidx.activity.ComponentActivity
import androidx.compose.material3.Text
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onLast
import androidx.compose.ui.test.performClick
import com.futo.notes.NotesStore
import com.futo.notes.awaitEditorLeaves
import com.futo.notes.localization.ProvideLocalization
import com.futo.notes.ui.navigation.AppNavigation
import com.futo.notes.ui.navigation.AppNavigator
import com.futo.notes.ui.navigation.Screen
import com.futo.notes.ui.theme.FutoNotesTheme
import java.io.File
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Rule
import org.junit.Test

/** Navigation and failure controls around the real native input/session, without test-only hooks. */
class TextFirstNavigationTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    private lateinit var root: File
    private lateinit var store: NotesStore
    private lateinit var navigator: AppNavigator
    private lateinit var editor: TextFirstEditText

    @Before fun open() {
        root = File(compose.activity.cacheDir, "navigation-${UUID.randomUUID()}").apply { check(mkdirs()) }
        store = NotesStore(root, File(root, "index"))
        store.core.createNote("draft", "", "base\n")
        compose.setContent {
            ProvideLocalization("en") {
                FutoNotesTheme(darkTheme = false) {
                    AppNavigation(hasBootstrapped = false, availableFolderPaths = emptyList()) { screen, nav, _ ->
                        navigator = nav
                        if (screen is Screen.Editor) TextFirstEditorScreen(
                            store, screen.noteId, false, false, nav::goBack, nav::openNote,
                            registerLeave = { handler -> nav.registerEditorLeave(screen, handler) },
                        ) else Text("Note list")
                    }
                }
            }
        }
        compose.runOnIdle { navigator.openNote("draft") }
        compose.waitUntil(10_000) {
            var found: TextFirstEditText? = null
            compose.runOnUiThread { found = findEditor(compose.activity.window.decorView) }
            found?.let { editor = it; it.text.toString().startsWith("base") } == true
        }
    }

    @After fun cleanup() {
        compose.runOnUiThread { compose.activity.setContentView(android.widget.FrameLayout(compose.activity)) }
        runBlocking { store.awaitEditorLeaves() }
        store.scope.cancel()
        store.core.destroy()
        root.deleteRecursively()
    }

    @Test fun backFailureKeepsTypingAndRetrySavesBeforeNavigating() {
        failSaves()
        type("draft ")
        compose.runOnIdle { navigator.goBack() }
        compose.waitUntil(10_000) { compose.onAllNodesWithText("Retry save").fetchSemanticsNodes().isNotEmpty() }
        compose.runOnIdle { assertTrue(navigator.currentScreen is Screen.Editor) }
        type("latest ")
        compose.runOnIdle { assertTrue(editor.text.toString().startsWith("draft latest base")) }
        restoreSaves()
        compose.onNodeWithText("Retry save").performClick()
        compose.waitUntil(10_000) { navigator.currentScreen is Screen.Folder }
        assertEquals("draft latest base\n", store.core.read("draft"))
    }

    /** Retry after a later autosave failure saves; only the Back that failed asked to leave. */
    @Test fun retryAfterARecoveredAutosaveDoesNotReplayAnOldBack() {
        fun barShown() = compose.onAllNodesWithText("Retry save").fetchSemanticsNodes().isNotEmpty()
        failSaves()
        type("draft ")
        compose.runOnIdle { navigator.goBack() }
        compose.waitUntil(10_000) { barShown() }
        restoreSaves()
        type("kept ")
        compose.waitUntil(10_000) { !barShown() }
        failSaves()
        type("more ")
        compose.waitUntil(10_000) { barShown() }
        restoreSaves("draft kept base\n") // what the successful autosave last wrote
        compose.onNodeWithText("Retry save").performClick()
        compose.waitUntil(10_000) { !barShown() }
        Thread.sleep(1_000)
        compose.runOnIdle { assertTrue("retry saves; it does not navigate", navigator.currentScreen is Screen.Editor) }
        assertTrue("disk: ${store.core.read("draft")}", store.core.read("draft")!!.contains("more"))
    }

    @Test fun failedLeaveRequiresExplicitDiscardConfirmation() {
        failSaves()
        type("discard me ")
        compose.runOnIdle { navigator.goBack() }
        compose.waitUntil(10_000) { compose.onAllNodesWithText("Discard edits").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("Discard edits").performClick()
        compose.onNodeWithText("Cancel").performClick()
        compose.runOnIdle { assertTrue(navigator.currentScreen is Screen.Editor) }
        compose.onNodeWithText("Discard edits").performClick()
        compose.onAllNodesWithText("Discard edits").onLast().performClick()
        compose.waitUntil(10_000) { navigator.currentScreen is Screen.Folder }
        restoreSaves()
        // Discard releases the lease; reopening sees only the previously saved body.
        store.core.openEditor("draft").use { session ->
            assertEquals("base\n", session.sourceText())
            session.detach()
        }
    }

    private fun failSaves() {
        check(File(root, "draft.md").delete())
        check(File(root, "draft.md").mkdir())
    }

    private fun restoreSaves(content: String = "base\n") {
        check(File(root, "draft.md").delete())
        File(root, "draft.md").writeText(content)
    }

    private fun type(text: String) {
        val typed = CountDownLatch(1)
        compose.runOnUiThread {
            val connection = editor.onCreateInputConnection(EditorInfo())!!
            connection.handler!!.post { connection.commitText(text, 1); typed.countDown() }
        }
        assertTrue(typed.await(10, TimeUnit.SECONDS))
        compose.waitForIdle()
    }

    private fun findEditor(view: View): TextFirstEditText? {
        if (view is TextFirstEditText) return view
        if (view is ViewGroup) for (i in 0 until view.childCount) findEditor(view.getChildAt(i))?.let { return it }
        return null
    }
}
