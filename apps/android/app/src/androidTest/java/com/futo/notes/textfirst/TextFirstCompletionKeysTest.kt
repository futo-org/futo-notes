package com.futo.notes.textfirst

import android.view.KeyEvent
import android.view.inputmethod.InputConnection
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/** Desktop's completion keys on a hardware keyboard: Up and Down move through the `[[` list, Enter or Tab take a row, Escape closes it. */
class TextFirstCompletionKeysTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    private val note = "start\n\n" + "ordinary note text ".repeat(10) + "\n"
    private val others = mapOf("Other alpha" to "a", "Other beta" to "b")

    private fun key(view: TextFirstEditText, keyCode: Int) {
        compose.runOnUiThread { view.onKeyDown(keyCode, KeyEvent(KeyEvent.ACTION_DOWN, keyCode)) }
        compose.waitForIdle()
    }

    private fun type(connection: InputConnection, vararg keys: String) {
        val typed = java.util.concurrent.CountDownLatch(1)
        connection.handler!!.post { for (k in keys) connection.commitText(k, 1); typed.countDown() }
        typed.await()
    }

    private fun shown(text: String) = compose.onAllNodesWithText(text).fetchSemanticsNodes().isNotEmpty()

    /** The note focused with its keyboard, `[[Oth` typed after "start", the two-row list shown. */
    private fun openList(view: TextFirstEditText, connection: InputConnection) {
        val scene = TableCellScene(view, compose.activity) { action -> compose.runOnUiThread(action) }
        scene.tap(scene.pointAt("ordinary"))
        compose.waitUntil(10_000) { readOnMainThread { view.isFocused } && scene.keyboardVisible() && scene.keyboardIdle() }
        compose.runOnUiThread { view.engine!!.hostSelect(5, 5) }
        compose.waitUntil(5_000) { readOnMainThread { view.selectionStart == 5 } }
        type(connection, "[", "[", "O", "t", "h")
        compose.waitUntil(10_000) { shown("Other alpha") && shown("Other beta") }
    }

    private fun inserted(view: TextFirstEditText, label: String) {
        compose.waitUntil(10_000) { readOnMainThread { view.text.toString() }.startsWith("start[[$label]]") }
    }

    @Test fun downAndEnterTakeTheSecondSuggestion() = compose.withTextFirstScreen(note, nativeTheme = tableSceneTheme, otherNotes = others) { view, connection ->
        openList(view, connection)
        key(view, KeyEvent.KEYCODE_DPAD_DOWN)
        key(view, KeyEvent.KEYCODE_ENTER)
        inserted(view, "Other beta")
    }

    @Test fun upFromTheFirstRowWrapsToTheLast() = compose.withTextFirstScreen(note, nativeTheme = tableSceneTheme, otherNotes = others) { view, connection ->
        openList(view, connection)
        key(view, KeyEvent.KEYCODE_DPAD_UP)
        key(view, KeyEvent.KEYCODE_TAB)
        inserted(view, "Other beta")
    }

    @Test fun tabTakesTheHighlightedRow() = compose.withTextFirstScreen(note, nativeTheme = tableSceneTheme, otherNotes = others) { view, connection ->
        openList(view, connection)
        key(view, KeyEvent.KEYCODE_TAB)
        inserted(view, "Other alpha")
    }

    @Test fun escapeClosesTheListAndKeepsTheText() = compose.withTextFirstScreen(note, nativeTheme = tableSceneTheme, otherNotes = others) { view, connection ->
        openList(view, connection)
        key(view, KeyEvent.KEYCODE_ESCAPE)
        compose.waitUntil(10_000) { !shown("Other alpha") }
        assertTrue(readOnMainThread { view.text.toString() }.startsWith("start[[Oth]]"))
    }

    /** A row highlighted below the list's new end, after the list shrinks, takes the row that is left. */
    @Test fun aListThatShrinksUnderTheHighlightTakesWhatIsLeft() = compose.withTextFirstScreen(note, nativeTheme = tableSceneTheme, otherNotes = others) { view, connection ->
        openList(view, connection)
        key(view, KeyEvent.KEYCODE_DPAD_DOWN)
        type(connection, "e", "r", " ", "a")
        compose.waitUntil(10_000) { shown("Other alpha") && !shown("Other beta") }
        key(view, KeyEvent.KEYCODE_ENTER)
        inserted(view, "Other alpha")
    }
}
