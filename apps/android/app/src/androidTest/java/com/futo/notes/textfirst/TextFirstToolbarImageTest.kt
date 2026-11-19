package com.futo.notes.textfirst

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.performScrollTo
import com.futo.notes.localization.Localization
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

/** Camera and Image are disabled where the engine would refuse an image (its `allowed` list): in code, a tap opens nothing. */
class TextFirstToolbarImageTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    private val strings = Localization.fromGeneratedCatalogs(listOf("en"), "en-US")

    @Test fun cameraAndImageFollowTheEnginesImageAnswer() = compose.withTextFirstScreen(
        "prose line here\n\n```js\ncode line here\n```\n\n" + "ordinary note text ".repeat(10) + "\n",
        nativeTheme = tableSceneTheme,
    ) { view, _ ->
        compose.runOnUiThread { view.showKeyboard() }
        val camera = strings.localizedText("editor.toolbar.takePhoto")
        val image = strings.localizedText("editor.toolbar.chooseFromLibrary")
        compose.waitUntil(10_000) { compose.onAllNodesWithContentDescription(image).fetchSemanticsNodes().isNotEmpty() }
        fun caretAt(text: String) {
            val at = readOnMainThread { view.editableText.indexOf(text) } + 2
            compose.runOnUiThread { view.engine!!.hostSelect(at, at) }
            compose.waitUntil(5_000) { readOnMainThread { view.selectionStart == at } }
            compose.waitForIdle()
        }
        caretAt("code line")
        compose.waitUntil(5_000) { runCatching { compose.onNodeWithContentDescription(image).assertIsNotEnabled() }.isSuccess }
        compose.onNodeWithContentDescription(camera).performScrollTo().assertIsNotEnabled()
        val before = readOnMainThread { view.text.toString() }
        // A real touch on the button's bounds; Compose's performClick waits for an idle the open keyboard never gives.
        // Camera, scrolled to above, sits beside Image: a second scroll request never settles under the toolbar's snapping.
        val bounds = compose.onNodeWithContentDescription(image).fetchSemanticsNode().boundsInWindow
        compose.runOnUiThread {
            val decor = compose.activity.window.decorView
            val down = android.os.SystemClock.uptimeMillis()
            for ((action, time) in listOf(android.view.MotionEvent.ACTION_DOWN to down, android.view.MotionEvent.ACTION_UP to down + 50)) {
                val event = android.view.MotionEvent.obtain(down, time, action, bounds.center.x, bounds.center.y, 0)
                event.source = android.view.InputDevice.SOURCE_TOUCHSCREEN
                try { decor.dispatchTouchEvent(event) } finally { event.recycle() }
            }
        }
        Thread.sleep(500)
        assertEquals("a tap on the disabled Image changed the note", before, readOnMainThread { view.text.toString() })
        caretAt("prose line")
        compose.waitUntil(5_000) { runCatching { compose.onNodeWithContentDescription(image).assertIsEnabled() }.isSuccess }
        compose.onNodeWithContentDescription(camera).assertIsEnabled()
    }
}
