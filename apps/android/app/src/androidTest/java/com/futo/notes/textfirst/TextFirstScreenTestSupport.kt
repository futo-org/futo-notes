package com.futo.notes.textfirst

import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import androidx.activity.ComponentActivity
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.junit4.AndroidComposeTestRule
import androidx.test.ext.junit.rules.ActivityScenarioRule
import androidx.test.platform.app.InstrumentationRegistry
import com.futo.notes.NotesStore
import com.futo.notes.localization.LocalLocalization
import com.futo.notes.localization.Localization
import com.futo.notes.ui.theme.FutoNotesTheme
import java.io.File
import java.util.UUID

/** The existing real note-screen fixture, shared by caret and in-place cell stories. */
internal fun AndroidComposeTestRule<ActivityScenarioRule<ComponentActivity>, ComponentActivity>.withTextFirstScreen(
    note: String,
    nativeTheme: Int? = null,
    check: (TextFirstEditText, InputConnection) -> Unit,
) {
    NoteScrollMemory.clear()
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    val scratch = File(context.cacheDir, "caret-follow-${UUID.randomUUID()}").apply { check(mkdirs()) }
    val root = File(scratch, "vault").apply { check(mkdirs()) }
    File(root, "draft.md").writeText(note)
    lateinit var store: NotesStore
    runOnUiThread {
        nativeTheme?.let {
            activity.setTheme(it)
            activity.enableEdgeToEdge()
            activity.window.setSoftInputMode(android.view.WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
        }
        store = NotesStore(root, File(scratch, "index"))
    }
    waitUntil(15_000) { store.hasBootstrapped }
    val localization = Localization.fromGeneratedCatalogs(listOf("en"), "en-US")
    setContent {
        FutoNotesTheme(darkTheme = false) {
            CompositionLocalProvider(LocalLocalization provides localization) {
                if (nativeTheme != null) com.futo.notes.ui.components.ClearFocusOnImeDismiss(
                    com.futo.notes.ui.components.imeTargetVisible(),
                )
                TextFirstEditorScreen(store, "draft", false, false, {}, {}, registerLeave = { {} })
            }
        }
    }
    lateinit var editor: TextFirstEditText
    fun find(view: View): TextFirstEditText? = when (view) {
        is TextFirstEditText -> view
        is ViewGroup -> (0 until view.childCount).firstNotNullOfOrNull { find(view.getChildAt(it)) }
        else -> null
    }
    // The whole note: a caret put at the end of a still-arriving prefix stays there as the rest lands.
    waitUntil(15_000) {
        var ready = false
        runOnUiThread {
            find(activity.window.decorView)?.let { if (it.length() > 100 && it.contentComplete) { editor = it; ready = true } }
        }
        ready
    }
    lateinit var connection: InputConnection
    runOnUiThread {
        editor.requestFocus()
        editor.engine!!.hostSelect(editor.length() - 1, editor.length() - 1)
        connection = checkNotNull(editor.onCreateInputConnection(EditorInfo()))
    }
    waitUntil(5_000) { editor.selectionStart == editor.length() - 1 && editor.selectionEnd == editor.length() - 1 }
    check(editor, connection)
}
