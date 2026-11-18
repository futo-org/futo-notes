package com.futo.notes.textfirst

import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import com.futo.notes.ui.FindQueryEditText
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
}
