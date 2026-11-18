package com.futo.notes.textfirst

import android.view.KeyEvent
import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Test

/** Mason's desktop rules in their phone form (desktop-decisions-on-android: ed-4, bl-10, lk-7). */
class TextFirstDesktopRulesTest {
    private suspend fun ready(c: TextFirstController, caret: Int, end: Int = caret) {
        val view = c.view
        view.isFocusableInTouchMode = true
        view.requestFocus()
        withTimeout(5_000) { while (view.layout == null) delay(20) }
        c.select(caret, end)
        delay(300)
    }

    private suspend fun chord(c: TextFirstController, keyCode: Int, meta: Int, before: String) {
        c.view.onKeyDown(keyCode, KeyEvent(0, 0, KeyEvent.ACTION_DOWN, keyCode, 0, meta))
        withTimeout(5_000) { while (c.sourceText() == before) delay(50) }
    }

    @Test fun ctrlAltXStrikesTheSelectionInsteadOfCuttingIt() = textFirstSession("alpha beta gamma") { c ->
        ready(c, 6, 10)
        chord(c, KeyEvent.KEYCODE_X, KeyEvent.META_CTRL_ON or KeyEvent.META_ALT_ON, "alpha beta gamma")
        assertEquals("alpha ~~beta~~ gamma", c.sourceText())
    }

    @Test fun ctrlAltDigitsAndCtrlShiftBMakeLines() = textFirstSession("alpha") { c ->
        ready(c, 2)
        chord(c, KeyEvent.KEYCODE_2, KeyEvent.META_CTRL_ON or KeyEvent.META_ALT_ON, "alpha")
        assertEquals("## alpha", c.sourceText())
        chord(c, KeyEvent.KEYCODE_8, KeyEvent.META_CTRL_ON or KeyEvent.META_ALT_ON, "## alpha")
        assertEquals("- alpha", c.sourceText())
        chord(c, KeyEvent.KEYCODE_B, KeyEvent.META_CTRL_ON or KeyEvent.META_SHIFT_ON, "- alpha")
        assertEquals("> - alpha", c.sourceText())
    }

    @Test fun backspaceAfterAWikilinkTakesItWhole() = textFirstSession("A [[Linked note]] here.") { c ->
        ready(c, c.view.editableText.indexOf(" here"))
        textFirstIme(c) { deleteSurroundingText(1, 0) }
        withTimeout(5_000) { while (c.sourceText() == "A [[Linked note]] here.") delay(50) }
        assertEquals("A  here.", c.sourceText())
        c.undo()
        withTimeout(5_000) { while (c.sourceText() != "A [[Linked note]] here.") delay(50) }
    }

    @Test fun deleteBeforeAWikilinkTakesItWhole() = textFirstSession("A [[Linked note]] here.") { c ->
        ready(c, 2)
        chord(c, KeyEvent.KEYCODE_FORWARD_DEL, 0, "A [[Linked note]] here.")
        assertEquals("A  here.", c.sourceText())
    }
}
