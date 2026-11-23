package com.futo.notes.textfirst

import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Test

/** interpretation-and-input.md: input at a caret the user placed lands where a fresh selection there would, so text typed where a span ends lands inside it. */
class TextFirstPlacedCaretTest {
    private suspend fun placeCaret(c: TextFirstController, offset: Int) {
        c.view.isFocusableInTouchMode = true
        c.view.requestFocus()
        withTimeout(5_000) { while (c.view.layout == null) delay(20) }
        c.view.setSelection(offset)
        delay(300)
    }

    @Test fun aCaretPlacedAtTheEndOfABoldWordTypesInsideIt() = textFirstSession("**world** foo") { c ->
        placeCaret(c, "world".length)
        textFirstIme(c) { commitText("X", 1) }
        assertEquals("**worldX** foo", c.sourceText())
    }
}
