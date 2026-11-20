package com.futo.notes.textfirst

import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import com.futo.notes.ui.FindQueryEditText
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.performClick
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

    /** Mason (S23): stepping from a match in a table cell back to the first match dropped the keyboard. The query keeps focus. */
    @Test fun stepsOntoAndOffACellsMatchKeepTheQueryFocused() = compose.withTextFirstScreen(
        "beta in prose\n\n| Name | Owner |\n| - | - |\n| one | beta |\n\n" + "ordinary note text ".repeat(10) + "\n", nativeTheme = tableSceneTheme,
    ) { view, _ ->
        assertEquals("beta", ctrlF(view, 0, 4))
        compose.waitUntil(10_000) { compose.onAllNodesWithText("1 of 2").fetchSemanticsNodes().isNotEmpty() }
        // The first step lands on the current match; the next ones move, onto the cell and back round to the first.
        for (shown in listOf("1 of 2", "2 of 2", "1 of 2", "2 of 2", "1 of 2")) {
            compose.runOnUiThread {
                query(compose.activity.window.decorView)!!.onKeyDown(KeyEvent.KEYCODE_G, KeyEvent(0, 0, KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_G, 0, KeyEvent.META_CTRL_ON))
            }
            compose.waitUntil(10_000) { compose.onAllNodesWithText(shown).fetchSemanticsNodes().isNotEmpty() }
            compose.waitForIdle()
            assertEquals("the query is focused at $shown", true, readOnMainThread { query(compose.activity.window.decorView)!!.isFocused })
        }
        // A press on the cell itself asks for it: its field takes the keyboard (Sol review of the batch, 1).
        val scene = TableCellScene(view, compose.activity) { action -> compose.runOnUiThread(action) }
        scene.tap(scene.pointAt("one", 1))
        compose.waitUntil(10_000) { scene.field()?.isFocused == true }
    }

    /** Sol review of the batch (2): closing find after it stepped onto a cell's match leaves that cell alone. */
    @Test fun closingFindOnACellsMatchStartsNoCellEditing() = compose.withTextFirstScreen(
        "beta in prose\n\n| Name | Owner |\n| - | - |\n| one | beta |\n\n" + "ordinary note text ".repeat(10) + "\n", nativeTheme = tableSceneTheme,
    ) { view, _ ->
        assertEquals("beta", ctrlF(view, 0, 4))
        for (shown in listOf("1 of 2", "2 of 2")) {
            compose.runOnUiThread {
                query(compose.activity.window.decorView)!!.onKeyDown(KeyEvent.KEYCODE_G, KeyEvent(0, 0, KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_G, 0, KeyEvent.META_CTRL_ON))
            }
            compose.waitUntil(10_000) { compose.onAllNodesWithText(shown).fetchSemanticsNodes().isNotEmpty() }
        }
        val strings = com.futo.notes.localization.Localization.fromGeneratedCatalogs(listOf("en"), "en-US")
        compose.onNodeWithContentDescription(strings.localizedText("editor.find.close")).performClick()
        compose.waitForIdle()
        Thread.sleep(500)
        val scene = TableCellScene(view, compose.activity) { action -> compose.runOnUiThread(action) }
        assertEquals("a cell field took focus", false, readOnMainThread { scene.field()?.isFocused == true })
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
