package com.futo.notes.textfirst

import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Test

/** Enter in a block lays out only what moved: a code line keeps its span, and one below it shows its new number. */
class TextFirstCodeLineSpanTest {
    @Test fun enterKeepsTheLinesAroundItAndRenumbersTheOnesBelow() = textFirstSession("```txt\none\ntwo\nthree\nfour\nfive\n```\n\nend") { c ->
        val view = c.view
        view.isFocusableInTouchMode = true
        view.requestFocus()
        withTimeout(5_000) { while (view.layout == null) delay(20) }
        val e = view.editableText
        fun spanAt(text: String) = e.indexOf(text).let { at -> e.getSpans(at, at, TfCodeBlock::class.java).single { e.getSpanStart(it) == at } }
        val above = spanAt("one")
        val below = spanAt("five")
        val caret = e.indexOf("two") + 3
        c.select(caret)
        withTimeout(5_000) { while (view.selectionStart != caret) delay(20) }
        textFirstIme(c) { commitText("\n", 1) }
        withTimeout(5_000) { while (spanAt("five").line.number != 6) delay(20) }
        assertSame("the line above the new one was laid out again", above, spanAt("one"))
        assertSame("the line below was replaced instead of renumbered", below, spanAt("five"))
        assertEquals(6, below.line.number)
    }
}
