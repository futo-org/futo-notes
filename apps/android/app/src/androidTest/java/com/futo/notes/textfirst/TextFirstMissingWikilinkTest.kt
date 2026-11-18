package com.futo.notes.textfirst

import android.view.View
import android.view.ViewGroup
import androidx.activity.ComponentActivity
import androidx.compose.material3.Text
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import com.futo.notes.NotesStore
import com.futo.notes.awaitEditorLeaves
import com.futo.notes.localization.ProvideLocalization
import com.futo.notes.ui.navigation.AppNavigation
import com.futo.notes.ui.navigation.AppNavigator
import com.futo.notes.ui.navigation.Screen
import com.futo.notes.ui.theme.FutoNotesTheme
import java.io.File
import java.util.UUID
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/** Mason's desktop rule, phone form: a tap on a wikilink to a missing note creates it and opens it; left untouched it goes again. */
class TextFirstMissingWikilinkTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    private lateinit var root: File
    private lateinit var store: NotesStore
    private lateinit var navigator: AppNavigator

    private fun findEditor(view: View): TextFirstEditText? {
        if (view is TextFirstEditText) return view
        if (view is ViewGroup) for (i in 0 until view.childCount) findEditor(view.getChildAt(i))?.let { return it }
        return null
    }

    private fun editorShowing(prefix: String): TextFirstEditText? {
        var found: TextFirstEditText? = null
        compose.runOnUiThread {
            found = findEditor(compose.activity.window.decorView)?.takeIf { it.layout != null && it.text.toString().startsWith(prefix) }
        }
        return found
    }

    @After fun cleanup() {
        compose.runOnUiThread { compose.activity.setContentView(android.widget.FrameLayout(compose.activity)) }
        runBlocking { store.awaitEditorLeaves() }
        store.scope.cancel()
        store.core.destroy()
        root.deleteRecursively()
    }

    @Test fun aTapOnAMissingWikilinkCreatesItsNoteAndAnUntouchedOneGoesAgain() {
        root = File(compose.activity.cacheDir, "missing-${UUID.randomUUID()}").apply { check(mkdirs()) }
        store = NotesStore(root, File(root, "index"))
        store.core.createNote("draft", "", "go [[Fresh idea]] now\n")
        compose.setContent {
            ProvideLocalization("en") {
                FutoNotesTheme(darkTheme = false) {
                    AppNavigation(hasBootstrapped = false, availableFolderPaths = emptyList()) { screen, nav, _ ->
                        navigator = nav
                        if (screen is Screen.Editor) TextFirstEditorScreen(
                            store, screen.noteId, screen.autoFocus, false, nav::goBack, nav::openNote, nav::openCreatedNote,
                            registerLeave = { handler -> nav.registerEditorLeave(screen, handler) },
                        ) else Text("Note list")
                    }
                }
            }
        }
        compose.runOnIdle { navigator.openNote("draft") }
        var editor: TextFirstEditText? = null
        compose.waitUntil(10_000) { editorShowing("go ").also { editor = it } != null }
        compose.runOnUiThread {
            val view = editor!!
            val start = view.text!!.indexOf("[[")
            val l = view.layout
            val x = view.totalPaddingLeft + l.getPrimaryHorizontal(start) + view.paint.textSize
            val y = view.totalPaddingTop - view.scrollY + l.getLineBaseline(l.getLineForOffset(start)) - view.paint.textSize / 3
            tapNoteAt(view, x, y)
        }
        compose.waitUntil(10_000) { (navigator.currentScreen as? Screen.Editor)?.noteId == "Fresh idea" }
        assertTrue("the note was not created", store.notes.any { it.id == "Fresh idea" })
        compose.runOnIdle { navigator.goBack() }
        compose.waitUntil(10_000) { (navigator.currentScreen as? Screen.Editor)?.noteId == "draft" }
        compose.waitUntil(10_000) { store.notes.none { it.id == "Fresh idea" } }
    }
}
