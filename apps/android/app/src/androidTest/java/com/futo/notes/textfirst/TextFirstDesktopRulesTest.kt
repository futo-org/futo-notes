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

    @Test fun aTypedAddressIsSavedAsAWebAddress() = textFirstSession("alpha beta") { c ->
        ready(c, 6, 10)
        val draft = c.linkDraft()!!
        assertEquals(true, c.editLink(draft, "beta", "example.com"))
        assertEquals("alpha [beta](https://example.com)", c.sourceText())
    }

    @Test fun ctrlKOpensTheLinkForm() = textFirstSession("alpha beta") { c ->
        ready(c, 6, 10)
        var opened = 0
        c.view.keyHooks.link = { opened++ }
        assertEquals(true, c.view.onKeyDown(KeyEvent.KEYCODE_K, KeyEvent(0, 0, KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_K, 0, KeyEvent.META_CTRL_ON)))
        assertEquals(1, opened)
    }

    private suspend fun ctrlEnterInACell(c: TextFirstController, typed: String = "z"): String? {
        val view = c.view
        view.isFocusableInTouchMode = true
        view.requestFocus()
        withTimeout(5_000) { while (view.layout == null) delay(20) }
        val cell = view.editableText.indexOf("c ")
        view.onTableCell!!(cell, cell, view.appliedSeq)
        withTimeout(5_000) { while (c.cellView == null) delay(20) }
        val field = c.cellView!!
        field.onKeyDown(KeyEvent.KEYCODE_ENTER, KeyEvent(0, 0, KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_ENTER, 0, KeyEvent.META_CTRL_ON))
        withTimeout(5_000) { while (c.cellView != null) delay(20) }
        delay(200)
        textFirstIme(c) { commitText(typed, 1) }
        return c.sourceText()
    }

    @Test fun ctrlEnterInACellGoesToTheEmptyLineAfterTheTable() = textFirstSession("| a | b |\n| - | - |\n| c | d |\n\nafter") { c ->
        assertEquals("| a | b |\n| - | - |\n| c | d |\nz\nafter", ctrlEnterInACell(c))
    }

    @Test fun ctrlEnterInACellOpensALineBeforeTextRightAfterTheTable() = textFirstSession("| a | b |\n| - | - |\n| c | d |\nafter") { c ->
        assertEquals("| a | b |\n| - | - |\n| c | d |\nz\nafter", ctrlEnterInACell(c))
    }

    @Test fun ctrlEnterInACellOfANoteEndingTableOpensALine() = textFirstSession("| a | b |\n| - | - |\n| c | d |") { c ->
        assertEquals("| a | b |\n| - | - |\n| c | d |\nz", ctrlEnterInACell(c))
    }

    @Test fun ctrlEnterAndCtrlShiftEnterOpenLinesInProse() = textFirstSession("alpha beta\nsecond") { c ->
        ready(c, 3)
        chord(c, KeyEvent.KEYCODE_ENTER, KeyEvent.META_CTRL_ON, "alpha beta\nsecond")
        textFirstIme(c) { commitText("x", 1) }
        assertEquals("alpha beta\nx\nsecond", c.sourceText())
        ready(c, c.view.editableText.indexOf("second") + 2)
        chord(c, KeyEvent.KEYCODE_ENTER, KeyEvent.META_CTRL_ON or KeyEvent.META_SHIFT_ON, "alpha beta\nx\nsecond")
        textFirstIme(c) { commitText("y", 1) }
        assertEquals("alpha beta\nx\ny\nsecond", c.sourceText())
    }

    @Test fun aTapOnADividerSelectsIt() = textFirstSession("above\n\n---\n\nbelow") { c ->
        ready(c, 0)
        val view = c.view
        val e = view.editableText
        val divider = e.getSpans(0, e.length, TfDivider::class.java).single()
        val start = e.getSpanStart(divider)
        val end = e.getSpanEnd(divider)
        val l = view.layout
        val line = l.getLineForOffset(start)
        tapNoteAt(view, view.totalPaddingLeft + view.width / 3f, view.totalPaddingTop - view.scrollY + (l.getLineTop(line) + l.getLineBottom(line)) / 2f)
        withTimeout(5_000) { while (view.selectionEnd != end) delay(20) }
        assertEquals(start to end, view.selectionStart to view.selectionEnd)
    }
}
