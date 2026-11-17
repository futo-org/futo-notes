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
}
