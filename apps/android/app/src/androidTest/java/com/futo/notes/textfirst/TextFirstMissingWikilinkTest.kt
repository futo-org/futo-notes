package com.futo.notes.textfirst

import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
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
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/** A tap on a wikilink to a missing note creates it through the store and opens it as a new note; left untouched it goes again. */
class TextFirstMissingWikilinkTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    private lateinit var root: File
    private lateinit var store: NotesStore
    private lateinit var navigator: AppNavigator
    private lateinit var before: List<String>

    private fun findEditor(view: View, accept: (TextFirstEditText) -> Boolean = { true }): TextFirstEditText? {
        if (view is TextFirstEditText) return view.takeIf(accept)
        if (view is ViewGroup) for (i in 0 until view.childCount) findEditor(view.getChildAt(i), accept)?.let { return it }
        return null
    }

    private fun editorShowing(prefix: String): TextFirstEditText? {
        var found: TextFirstEditText? = null
        compose.runOnUiThread {
            found = findEditor(compose.activity.window.decorView) { it.layout != null && it.text.toString().startsWith(prefix) }
        }
        return found
    }

    private fun openDraft(body: String, vault: (NotesStore) -> Unit = {}): TextFirstEditText {
        root = File(compose.activity.cacheDir, "missing-${UUID.randomUUID()}").apply { check(mkdirs()) }
        store = NotesStore(root, File(root, "index"))
        vault(store)
        store.core.createNote("draft", "", body)
        before = vaultNotes()
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
        return editor!!
    }

    private fun tapLink(view: TextFirstEditText, times: Int = 1) = compose.runOnUiThread {
        val e = view.editableText
        val link = e.getSpans(0, view.length(), TfWikilink::class.java).single()
        val start = e.getSpanStart(link)
        val l = view.layout
        // On the label's text: a tap beside it follows nothing.
        val x = view.totalPaddingLeft + l.getPrimaryHorizontal(start) + link.getSize(link.renderedPaint(view.paint), e, start, e.getSpanEnd(link), null) / 2f
        val y = view.totalPaddingTop - view.scrollY + l.getLineBaseline(l.getLineForOffset(start)) - view.paint.textSize / 3
        repeat(times) { tapNoteAt(view, x, y) }
    }

    private fun awaitOpened(id: String) = compose.waitUntil(10_000) { (navigator.currentScreen as? Screen.Editor)?.noteId == id }

    private fun backToDraft() {
        compose.runOnIdle { navigator.goBack() }
        awaitOpened("draft")
        compose.waitUntil(10_000) { editorShowing("go ") != null }
        runBlocking { store.awaitEditorLeaves() }
    }

    private fun drawnLink(): TfWikilink {
        var link: TfWikilink? = null
        compose.runOnUiThread { link = editorShowing("go ")!!.editableText.let { it.getSpans(0, it.length, TfWikilink::class.java).single() } }
        return link!!
    }

    private fun vaultNotes(): List<String> = root.walkTopDown().filter { it.isFile && it.extension == "md" }.map { it.relativeTo(root).path }.sorted().toList()

    @After fun cleanup() {
        compose.runOnUiThread { compose.activity.setContentView(android.widget.FrameLayout(compose.activity)) }
        runBlocking { store.awaitEditorLeaves() }
        store.scope.cancel()
        store.core.destroy()
        root.deleteRecursively()
    }

    @Test fun anUntouchedNoteIsDeletedOnLeavingAndTheLinkIsMissingAgain() {
        tapLink(openDraft("go [[Fresh idea]] now\n"))
        awaitOpened("Fresh idea")
        assertTrue("the note was not created", File(root, "Fresh idea.md").isFile)
        backToDraft()
        compose.waitUntil(10_000) { drawnLink().noteId == null }
        assertEquals(before, vaultNotes())
    }

    @Test fun oneTypedLetterKeepsTheNoteAndTheLinkResolves() {
        tapLink(openDraft("go [[Fresh idea]] now\n"))
        awaitOpened("Fresh idea")
        var created: TextFirstEditText? = null
        compose.waitUntil(10_000) {
            var opened: TextFirstEditText? = null
            compose.runOnUiThread { opened = findEditor(compose.activity.window.decorView) { it.layout != null && !it.text.toString().startsWith("go ") } }
            opened?.also { created = it }?.engine != null
        }
        compose.runOnUiThread {
            val connection = created!!.onCreateInputConnection(EditorInfo())!!
            connection.handler!!.post { connection.commitText("x", 1) }
        }
        compose.waitUntil(10_000) { created!!.text.toString().startsWith("x") }
        backToDraft()
        compose.waitUntil(10_000) { drawnLink().noteId == "Fresh idea" }
        assertEquals("x", File(root, "Fresh idea.md").readText().trim())
    }

    @Test fun twoFastTapsMakeOneNoteAndNoneIsLeftUntouched() {
        tapLink(openDraft("go [[Fresh idea]] now\n"), times = 2)
        awaitOpened("Fresh idea")
        compose.waitForIdle()
        assertEquals((before + "Fresh idea.md").sorted(), vaultNotes())
        backToDraft()
        assertEquals(before, vaultNotes())
    }

    /** wikilinks.md: an ambiguous target renders broken as an absent one does, so a tap makes the root note it names. */
    @Test fun anAmbiguousTargetMakesTheRootNoteItNames() {
        tapLink(openDraft("go [[x]] now\n") { it.core.createNote("x", "A", ""); it.core.createNote("x", "B", "") })
        awaitOpened("x")
        assertTrue(File(root, "x.md").isFile)
        backToDraft()
        assertEquals(before, vaultNotes())
    }

    /** The store's title rule drops what a file name cannot hold; the link names a note it cannot have and stays missing. */
    @Test fun aTargetAFileNameCannotHoldIsNamedByTheStore() {
        tapLink(openDraft("go [[a:b?c]] now\n"))
        awaitOpened("abc")
        backToDraft()
        assertFalse(File(root, "abc.md").exists())
        assertEquals(null, drawnLink().noteId)
    }
}
