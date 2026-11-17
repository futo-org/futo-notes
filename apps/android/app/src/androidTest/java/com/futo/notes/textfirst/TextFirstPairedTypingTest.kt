package com.futo.notes.textfirst

import android.view.KeyEvent
import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Phones pair too (Mason, 2026-11-17; paired-typing.md): a character the keyboard commits on its own, with no
 * composition open, goes to the engine as paired typing. Each of these fails if it goes back to plain typing.
 */
class TextFirstPairedTypingTest {
    private suspend fun type(c: TextFirstController, vararg keys: String) {
        for (key in keys) {
            textFirstIme(c) { commitText(key, 1) }
            c.sourceText()
        }
    }

    private suspend fun caretAtEnd(c: TextFirstController) {
        c.view.isFocusableInTouchMode = true
        c.view.requestFocus()
        withTimeout(5_000) { while (c.view.layout == null) delay(20) }
        c.view.setSelection(c.view.length() - TextFirstEditText.END_SENTINEL.length)
        delay(200)
    }

    @Test fun aBacktickWritesAPairWithTheCaretBetween() = textFirstSession("x ") { c ->
        caretAtEnd(c)
        type(c, "`", "a")
        assertEquals("x `a`", c.sourceText())
    }

    @Test fun anAsteriskPairsAndGrowsAndIsPlainAfterALetter() = textFirstSession("x ") { c ->
        caretAtEnd(c)
        type(c, "*", "*", "b")
        assertEquals("x **b**", c.sourceText())
        type(c, "*", "*", " a", "*")
        assertEquals("x **b** a*", c.sourceText())
    }

    @Test fun twoTildesWriteAStrikePair() = textFirstSession("x ") { c ->
        caretAtEnd(c)
        type(c, "~", "~", "s")
        assertEquals("x ~~s~~", c.sourceText())
    }

    @Test fun bracketsPairGrowAndStepOver() = textFirstSession("x ") { c ->
        caretAtEnd(c)
        type(c, "[", "a", "]", "!")
        assertEquals("x [a]!", c.sourceText())
    }

    @Test fun backspaceTakesAnEmptyPairDownOneLevel() = textFirstSession("x ") { c ->
        caretAtEnd(c)
        type(c, "*", "*")
        assertEquals("x ****", c.sourceText())
        textFirstIme(c) { deleteSurroundingText(1, 0) }
        assertEquals("x **", c.sourceText())
        textFirstIme(c) { deleteSurroundingText(1, 0) }
        assertEquals("x ", c.sourceText())
    }

    /**
     * Pairing verifier, FUTO Keyboard: autocorrect commits the corrected word and the closing `*` together
     * ("wrold" composed, then "world*" committed). The `*` is still the key the user typed: it steps out of the bold.
     */
    @Test fun anAutocorrectThatEndsInAPairCharacterStillStepsOut() = textFirstSession("x ") { c ->
        caretAtEnd(c)
        type(c, "*", "*")
        textFirstIme(c) { setComposingText("wrold", 1) }
        textFirstIme(c) { commitText("world*", 1) }
        c.sourceText()
        type(c, " y")
        assertEquals("x **world** y", c.sourceText())
    }

    /** Pairing verifier: after Backspace takes the caret back out of italic text, the next letter is plain. */
    @org.junit.Ignore("blocked: engine. After Backspace deletes through italic text the next letters are italic (`en*d*`), with plain typing too, while the caret state reports no format")
    @Test fun backspacingOutOfItalicLeavesTheNextLetterPlain() = textFirstSession("end") { c ->
        caretAtEnd(c)
        type(c, " ", "a", "*", "2", "*", "3")
        repeat(5) { textFirstIme(c) { deleteSurroundingText(1, 0) } }
        assertEquals("en", c.sourceText())
        type(c, "d")
        assertEquals("end", c.sourceText())
    }

    @Test fun aLongerCommitIsTypedAsGiven() = textFirstSession("x ") { c ->
        caretAtEnd(c)
        type(c, "``")
        assertEquals("x ``", c.sourceText())
    }

    @Test fun aHardwareBacktickPairsToo() = textFirstSession("x ") { c ->
        caretAtEnd(c)
        c.view.onKeyDown(KeyEvent.KEYCODE_GRAVE, KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_GRAVE))
        delay(300)
        assertEquals("x ``", c.sourceText())
    }

    @Test fun theThirdBacktickMakesABlockAndItsLanguageFieldTakesTheLetters() = textFirstSession("intro\n") { c ->
        c.view.codeChrome.labels = CodeBlockLabels("add a line above", "add a line below", "name", "language")
        caretAtEnd(c)
        type(c, "`", "`")
        type(c, "`")
        withTimeout(5_000) { while (openHeaderFieldOrNull(c.view)?.isFocused != true) delay(20) }
        val field = openHeaderField(c.view)
        val input = field.onCreateInputConnection(android.view.inputmethod.EditorInfo())!!
        input.commitText("js", 1)
        assertEquals("intro\n```js\n```", c.sourceText()!!.trimEnd('\n'))
        input.sendKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_ENTER))
        c.sourceText()
        assertEquals(false, field.isAttachedToWindow)
    }

    private fun openHeaderFieldOrNull(view: TextFirstEditText): android.widget.EditText? {
        val host = view.parent as android.view.ViewGroup
        return (0 until host.childCount).map(host::getChildAt).filterIsInstance<android.widget.EditText>().firstOrNull { it !== view }
    }
}
