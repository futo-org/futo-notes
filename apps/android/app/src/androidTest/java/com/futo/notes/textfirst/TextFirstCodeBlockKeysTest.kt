package com.futo.notes.textfirst

import android.view.KeyEvent
import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Test

/** Area 6 verifier (P144): an arrow from a selected block toward an empty block at the note's edge leaves the selection where it is. */
class TextFirstCodeBlockKeysTest {
    private suspend fun selectBlockAndPress(c: TextFirstController, code: String, keyCode: Int) {
        val view = c.view
        view.isFocusableInTouchMode = true
        view.requestFocus()
        val start = view.editableText.indexOf(code)
        withTimeout(5_000) { while (view.codeChrome.areaOf(start, CodeBlockAction.SELECT_BLOCK) == null) delay(20) }
        val area = view.codeChrome.areaOf(start, CodeBlockAction.SELECT_BLOCK)!!
        tapNoteAt(view, view.totalPaddingLeft + area.centerX(), view.totalPaddingTop - view.scrollY + area.centerY())
        withTimeout(5_000) { while (view.selectedCodeBlock == null) delay(20) }
        val selected = view.selectedCodeBlock
        view.onKeyDown(keyCode, KeyEvent(KeyEvent.ACTION_DOWN, keyCode))
        delay(300)
        assertEquals("the arrow moved into the empty block", selected, view.selectedCodeBlock)
    }

    @Test fun upTowardAnEmptyBlockOpeningTheNoteStays() = textFirstSession("```\n```\n```js\nconst a = 1\n```\n\nend") { c ->
        selectBlockAndPress(c, "const a", KeyEvent.KEYCODE_DPAD_UP)
    }

    @Test fun downTowardAnEmptyBlockEndingTheNoteStays() = textFirstSession("start\n\n```js\nconst a = 1\n```\n```\n```") { c ->
        selectBlockAndPress(c, "const a", KeyEvent.KEYCODE_DPAD_DOWN)
    }

    /** Area 8 verifier (P220): Shift-Tab at the very start of the first code line opens the block's language field. */
    @Test fun shiftTabAtTheCodesStartOpensTheLanguageField() = textFirstSession("intro\n\n```go\ntwo\n```\n\nend") { c ->
        val view = c.view
        view.isFocusableInTouchMode = true
        view.requestFocus()
        val start = view.editableText.indexOf("two")
        withTimeout(5_000) { while (view.codeChrome.areaOf(start, CodeBlockAction.LANGUAGE_LABEL) == null) delay(20) }
        view.setSelection(start)
        delay(200)
        view.onKeyDown(KeyEvent.KEYCODE_TAB, KeyEvent(0, 0, KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_TAB, 0, KeyEvent.META_SHIFT_ON))
        withTimeout(5_000) { while (view.codeTouch.headerField.openField == null) delay(20) }
        assertEquals(start to CodeHeaderField.Kind.LANGUAGE, view.codeTouch.headerField.openField)
    }

    /** Area 4 verifier (P091): Ctrl+Shift+Enter opens a line above with the line's indent, the caret on it. */
    @Test fun ctrlShiftEnterOpensAnIndentedLineAbove() = textFirstSession("```py\ndef f():\n    return x\n```\n\nend") { c ->
        val view = c.view
        view.isFocusableInTouchMode = true
        view.requestFocus()
        withTimeout(5_000) { while (view.layout == null) delay(20) }
        view.setSelection(view.editableText.indexOf("turn"))
        delay(200)
        view.onKeyDown(KeyEvent.KEYCODE_ENTER, KeyEvent(0, 0, KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_ENTER, 0, KeyEvent.META_CTRL_ON or KeyEvent.META_SHIFT_ON))
        withTimeout(5_000) { while (c.sourceText() == "```py\ndef f():\n    return x\n```\n\nend") delay(50) }
        textFirstIme(c) { commitText("z", 1) }
        assertEquals("```py\ndef f():\n    z\n    return x\n```\n\nend", c.sourceText())
    }

    /** Area 13 verifier (P306): Down on the last line of a block that ends the note opens a line below it. */
    @Test fun downOnTheLastLineOfANoteEndingBlockOpensALine() = textFirstSession("intro\n\n```js\nconst a = 1\n```") { c ->
        val view = c.view
        view.isFocusableInTouchMode = true
        view.requestFocus()
        withTimeout(5_000) { while (view.layout == null) delay(20) }
        view.setSelection(view.editableText.indexOf("a = 1"))
        delay(200)
        view.onKeyDown(KeyEvent.KEYCODE_DPAD_DOWN, KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_DPAD_DOWN))
        withTimeout(5_000) { while (c.sourceText() == "intro\n\n```js\nconst a = 1\n```") delay(50) }
        textFirstIme(c) { commitText("x", 1) }
        assertEquals("intro\n\n```js\nconst a = 1\n```\nx", c.sourceText())
    }

    /** Area 13 verifier (P303): Up at the note's start is the note's; it does not move focus to the title. */
    @Test fun upAtTheNotesStartKeepsTheKey() = textFirstSession("first line\nsecond") { c ->
        val view = c.view
        view.isFocusableInTouchMode = true
        view.requestFocus()
        withTimeout(5_000) { while (view.layout == null) delay(20) }
        view.setSelection(0)
        delay(200)
        assertEquals(true, view.onKeyDown(KeyEvent.KEYCODE_DPAD_UP, KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_DPAD_UP)))
        assertEquals(true, view.onKeyDown(KeyEvent.KEYCODE_PAGE_UP, KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_PAGE_UP)))
    }
}
