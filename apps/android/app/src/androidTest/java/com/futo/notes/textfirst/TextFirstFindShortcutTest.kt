package com.futo.notes.textfirst

import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import com.futo.notes.ui.FindQueryEditText
import androidx.compose.ui.test.onAllNodesWithText
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

/** Desktop's Ctrl+F on a hardware keyboard: the find bar opens with a one-line selection as its query. */
class TextFirstFindShortcutTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    private fun query(view: View): FindQueryEditText? {
        if (view is FindQueryEditText) return view
        if (view is ViewGroup) for (i in 0 until view.childCount) query(view.getChildAt(i))?.let { return it }
        return null
    }

    private fun ctrlF(view: TextFirstEditText, start: Int, end: Int): String {
        compose.runOnUiThread {
            view.requestFocus()
            view.setSelection(start, end)
            view.onKeyDown(KeyEvent.KEYCODE_F, KeyEvent(0, 0, KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_F, 0, KeyEvent.META_CTRL_ON))
        }
        compose.waitUntil(10_000) { readOnMainThread { query(compose.activity.window.decorView) } != null }
        compose.waitForIdle()
        return readOnMainThread { query(compose.activity.window.decorView)!!.text.toString() }
    }

    @Test fun ctrlFTakesAOneLineSelectionAsTheQuery() = compose.withTextFirstScreen("alpha beta gamma\nsecond line\n\n" + "ordinary note text ".repeat(10) + "\n") { view, _ ->
        val start = readOnMainThread { view.text.toString().indexOf("beta") }
        assertEquals("beta", ctrlF(view, start, start + 4))
    }

    @Test fun ctrlFOverSeveralLinesOpensEmpty() = compose.withTextFirstScreen("alpha beta gamma\nsecond line\n\n" + "ordinary note text ".repeat(10) + "\n") { view, _ ->
        val end = readOnMainThread { view.text.toString().indexOf("second") + 3 }
        assertEquals("", ctrlF(view, 2, end))
    }

    @Test fun ctrlGInTheQueryStepsToTheNextMatch() = compose.withTextFirstScreen("beta one\nbeta two\nbeta three\n\n" + "ordinary note text ".repeat(10) + "\n") { view, _ ->
        assertEquals("beta", ctrlF(view, 0, 4))
        compose.waitUntil(10_000) { compose.onAllNodesWithText("1 of 3").fetchSemanticsNodes().isNotEmpty() }
        compose.runOnUiThread {
            val field = query(compose.activity.window.decorView)!!
            field.onKeyDown(KeyEvent.KEYCODE_G, KeyEvent(0, 0, KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_G, 0, KeyEvent.META_CTRL_ON))
            field.onKeyDown(KeyEvent.KEYCODE_G, KeyEvent(0, 0, KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_G, 0, KeyEvent.META_CTRL_ON))
        }
        compose.waitUntil(10_000) { compose.onAllNodesWithText("2 of 3").fetchSemanticsNodes().isNotEmpty() }
    }

    @Test fun ctrlEnterInACellLeavesTheNoteFocused() = compose.withTextFirstScreen(
        "| Name | Owner |\n| - | - |\n| one | two |\n\n" + "ordinary note text ".repeat(10) + "\n", nativeTheme = tableSceneTheme,
    ) { view, _ ->
        val scene = TableCellScene(view, compose.activity) { action -> compose.runOnUiThread(action) }
        compose.runOnUiThread { view.revealRange(0, 0) }
        scene.tap(scene.pointAt("one", 0))
        compose.waitUntil(9_000) { scene.field()?.isFocused == true }
        compose.runOnUiThread {
            scene.field()!!.onKeyDown(KeyEvent.KEYCODE_ENTER, KeyEvent(0, 0, KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_ENTER, 0, KeyEvent.META_CTRL_ON))
        }
        compose.waitUntil(10_000) { scene.field() == null }
        compose.waitForIdle()
        assertEquals("the note lost focus", true, readOnMainThread { view.isFocused })
    }

    /** Ctrl+K reaches the toolbar's link form through the screen's own wiring, not a hook a test sets. */
    @Test fun ctrlKOpensTheToolbarsLinkForm() = compose.withTextFirstScreen("alpha beta gamma\nsecond line\n\n" + "ordinary note text ".repeat(10) + "\n") { view, _ ->
        val start = readOnMainThread { view.text.toString().indexOf("beta") }
        compose.runOnUiThread {
            view.requestFocus()
            view.engine!!.hostSelect(start, start + 4)
        }
        compose.waitUntil(5_000) { readOnMainThread { view.selectionEnd == start + 4 } }
        compose.runOnUiThread {
            view.onKeyDown(KeyEvent.KEYCODE_K, KeyEvent(0, 0, KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_K, 0, KeyEvent.META_CTRL_ON))
        }
        compose.waitUntil(10_000) { compose.onAllNodesWithText("Link text").fetchSemanticsNodes().isNotEmpty() }
    }
}
