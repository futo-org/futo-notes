package com.futo.notes.textfirst

import android.view.KeyEvent
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/** Desktop's completion keys on a hardware keyboard: Down moves through the `[[` list and Enter takes the row. */
class TextFirstCompletionKeysTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    private val note = "start\n\n" + "ordinary note text ".repeat(10) + "\n"

    private fun key(view: TextFirstEditText, keyCode: Int) {
        compose.runOnUiThread { view.onKeyDown(keyCode, KeyEvent(KeyEvent.ACTION_DOWN, keyCode)) }
        compose.waitForIdle()
    }

    @Test fun downAndEnterTakeTheSecondSuggestion() = compose.withTextFirstScreen(
        note, nativeTheme = tableSceneTheme, otherNotes = mapOf("Other alpha" to "a", "Other beta" to "b"),
    ) { view, connection ->
        val scene = TableCellScene(view, compose.activity) { action -> compose.runOnUiThread(action) }
        scene.tap(scene.pointAt("ordinary"))
        compose.waitUntil(10_000) { readOnMainThread { view.isFocused } && scene.keyboardVisible() && scene.keyboardIdle() }
        compose.runOnUiThread { view.engine!!.hostSelect(5, 5) }
        compose.waitUntil(5_000) { readOnMainThread { view.selectionStart == 5 } }
        val typed = java.util.concurrent.CountDownLatch(1)
        connection.handler!!.post { for (k in listOf("[", "[", "O", "t", "h")) connection.commitText(k, 1); typed.countDown() }
        typed.await()
        val listShown = runCatching { compose.waitUntil(10_000) { compose.onAllNodesWithText("Other beta").fetchSemanticsNodes().isNotEmpty() } }.isSuccess
        assertTrue("no list, focused=" + readOnMainThread { view.isFocused.toString() + " " + view.text.toString().take(12) }, listShown)
        key(view, KeyEvent.KEYCODE_DPAD_DOWN)
        key(view, KeyEvent.KEYCODE_ENTER)
        compose.waitUntil(10_000) { readOnMainThread { view.text.toString() }.let { "[[Other" in it && "Oth]]" !in it } }
        val shown = readOnMainThread { view.text.toString() }
        assertTrue(shown, shown.startsWith("start[[Other beta]]"))
    }
}
