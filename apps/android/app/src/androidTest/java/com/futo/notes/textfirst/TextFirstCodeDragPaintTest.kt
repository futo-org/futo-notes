package com.futo.notes.textfirst

import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Tester (round 2, F4): a handle dragged out of a code block left the selection clamped at the block's end while the
 * handle went on. A selection begun in code follows its handle out: it then takes the block whole, as one begun outside.
 */
class TextFirstCodeDragPaintTest {
    @Test fun aDragFromCodeIntoTheTextBelowFollowsTheHandleAndTakesTheBlock() = textFirstSession("intro line\n\n```js\nconst a = 1\nconst b = 2\n```\n\nouter line\n") { c ->
        val view = c.view
        view.isFocusableInTouchMode = true
        view.requestFocus()
        withTimeout(5_000) { while (view.layout == null) delay(20) }
        val anchor = view.editableText.indexOf("a = 1")
        val codeStart = view.editableText.indexOf("const a")
        val handle = view.editableText.indexOf("outer") + 3
        view.setSelection(anchor, anchor)
        delay(200)
        view.setSelection(anchor, handle)
        delay(300)
        assertEquals("the paint follows the handle and takes the block", codeStart to handle, view.codeSelection?.let { it.start to it.end })
        // Round 3 (N1): the view's own range is the one painted and copied, so Share sends it and both handles sit on it.
        assertEquals("the view's selection is the painted range", codeStart to handle, view.selectionStart to view.selectionEnd)
    }

    /** Sol (round 3): from the code's end onto the line below holds nothing, as the engine copies nothing. */
    @Test fun aRangeFromTheCodesEndOntoTheLineBelowHoldsNothing() = textFirstSession("```js\nconst a = 1\n```\nafter\n") { c ->
        val view = c.view
        view.isFocusableInTouchMode = true
        view.requestFocus()
        withTimeout(5_000) { while (view.layout == null) delay(20) }
        val codeEnd = view.editableText.indexOf("= 1") + 3
        val after = view.editableText.indexOf("after")
        view.setSelection(codeEnd, codeEnd)
        delay(200)
        view.setSelection(codeEnd, after)
        delay(300)
        assertEquals("nothing is selected: the caret is at the line below", after to after, view.selectionStart to view.selectionEnd)
    }

    /** Sol (round 4): in a CRLF note the line break is two characters, neither of them code. */
    @Test fun aRangeFromTheCodesEndOntoTheLineBelowHoldsNothingInACrlfNote() = textFirstSession("```js\r\ncode\r\n```\r\nnext\r\n") { c ->
        val view = c.view
        view.isFocusableInTouchMode = true
        view.requestFocus()
        withTimeout(5_000) { while (view.layout == null) delay(20) }
        val codeEnd = view.editableText.indexOf("code") + 4
        val next = view.editableText.indexOf("next")
        view.setSelection(codeEnd, codeEnd)
        delay(200)
        view.setSelection(codeEnd, next)
        delay(300)
        assertEquals("nothing of the block is selected", next to next, view.selectionStart to view.selectionEnd)
    }
}
