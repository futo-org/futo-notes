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
        assertEquals("the handle is at the selection's end", handle, view.selectionEnd)
    }
}
