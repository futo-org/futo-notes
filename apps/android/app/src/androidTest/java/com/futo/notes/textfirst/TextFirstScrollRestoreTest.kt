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
import org.junit.Assert.*
import org.junit.Before
import org.junit.Rule
import org.junit.Test

/** Leaving a note and coming back lands where it was left, and shows the page without waiting for the whole note. */
class TextFirstScrollRestoreTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    private lateinit var root: File
    private lateinit var store: NotesStore
    private lateinit var navigator: AppNavigator

    private fun longNote() = buildString {
        for (i in 0 until 300) append("## Section $i\n\nSome **bold** prose for section $i.\n\n- one\n- two\n\n")
    }

    @Before fun open() {
        NoteScrollMemory.clear()
        root = File(compose.activity.cacheDir, "restore-${UUID.randomUUID()}").apply { check(mkdirs()) }
        store = NotesStore(root, File(root, "index"))
        store.core.createNote("long", "", longNote())
        store.core.createNote("short", "", "just a line")
        store.core.createNote("deep", "", buildString { for (i in 0 until 3000) append("## Section $i\n\nSome **bold** prose for section $i.\n\n- one\n- two\n\n") })
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
    }

    @After fun cleanup() {
        compose.runOnUiThread { compose.activity.setContentView(android.widget.FrameLayout(compose.activity)) }
        runBlocking { store.awaitEditorLeaves() }
        store.scope.cancel()
        store.core.destroy()
        root.deleteRecursively()
        NoteScrollMemory.clear()
    }

    private fun editor(): TextFirstEditText? {
        var found: TextFirstEditText? = null
        compose.runOnUiThread { found = find(compose.activity.window.decorView) }
        return found
    }

    private fun find(view: View): TextFirstEditText? {
        if (view is TextFirstEditText) return view
        if (view is ViewGroup) for (i in 0 until view.childCount) find(view.getChildAt(i))?.let { return it }
        return null
    }

    private fun openAndWait(noteId: String, startsWith: String): TextFirstEditText {
        compose.runOnIdle { navigator.openNote(noteId) }
        var view: TextFirstEditText? = null
        compose.waitUntil(120_000) {
            view = editor()
            view?.let { it.text.toString().startsWith(startsWith) } == true
        }
        return view!!
    }

    private fun goBack() {
        compose.runOnIdle { navigator.goBack() }
        compose.waitUntil(120_000) { navigator.currentScreen is Screen.Folder }
    }

    @Test fun returningToANoteLandsOnTheLineItWasLeftAt() {
        val first = openAndWait("long", "Section 0")
        // Once the whole note is in, so the position is well past the first slice and stable.
        compose.waitUntil(120_000) { first.engine!!.tailLength == 0 }
        compose.runOnUiThread { first.scrollTo(0, first.layout.height / 2) }
        var anchorText = ""
        compose.runOnUiThread { anchorText = first.text.toString().substring(first.scrollAnchor()!!.offset).take(40) }
        goBack()

        val second = openAndWait("long", "Section 0")
        compose.waitUntil(120_000) { compose.runOnUiThread { }; second.restoring == null }
        compose.runOnIdle {
            val now = second.scrollAnchor()!!
            assertEquals("the same line is at the top", anchorText, second.text.toString().substring(now.offset).take(40))
            assertTrue("scrolled, not at the top: ${second.scrollY}", second.scrollY > 0)
        }
    }

    @Test fun aNoteLeftAtItsTopReopensAtItsTop() {
        val first = openAndWait("long", "Section 0")
        compose.runOnUiThread { first.scrollTo(0, 5_000) }
        compose.runOnUiThread { first.scrollTo(0, 0) }
        goBack()
        val second = openAndWait("long", "Section 0")
        compose.runOnIdle { assertEquals(0, second.scrollY) }
    }

    /** Deeper than the first slice reaches: the note shows its top at once, then the view jumps when the line arrives. */
    @Test fun aLineBeyondTheFirstSliceReachIsRestoredOnceItArrives() {
        val wanted = 150_000
        NoteScrollMemory.put("deep", ScrollAnchor(wanted, 0))
        val view = openAndWait("deep", "Section 0")
        compose.waitUntil(120_000) { compose.runOnUiThread { }; view.restoring == null }
        compose.runOnIdle {
            val now = view.scrollAnchor()!!
            assertTrue("landed on the saved line: ${now.offset}", kotlin.math.abs(now.offset - wanted) < 200)
            assertTrue("scrolled: ${view.scrollY}", view.scrollY > 0)
        }
    }
}
