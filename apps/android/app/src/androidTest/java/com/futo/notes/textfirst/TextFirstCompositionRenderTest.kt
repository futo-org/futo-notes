package com.futo.notes.textfirst

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Round 4: composing text (a keyboard's underlined word) goes through the edit path that moves the renderer's spans
 * with the text. While a word is composed it is underlined and its row keeps its look; once committed the view holds
 * the spans a fresh open lays out, the underline gone.
 */
class TextFirstCompositionRenderTest {
    private val note = "- item one\n- item two\n\n# Title here\n\n```js\nconst a = 1\n```\n\nend\n"

    private suspend fun ready(c: TextFirstController) {
        withContext(Dispatchers.Main) { c.view.isFocusableInTouchMode = true; c.view.requestFocus() }
        withTimeout(5_000) { while (withContext(Dispatchers.Main) { c.view.layout == null }) delay(20) }
    }

    /**
     * Compose "ab", then "abcd", at [at]; [rowLook] names the block span the composed text must keep; commit, and the
     * note's source holds [saved] (the committed text where it was composed).
     */
    private suspend fun composeAt(c: TextFirstController, at: Int, what: String, rowLook: Class<out TfSpan>, saved: String) {
        c.select(at)
        withTimeout(5_000) { while (withContext(Dispatchers.Main) { c.view.selectionStart != at }) delay(20) }
        for (word in listOf("ab", "abcd")) {
            textFirstIme(c) { setComposingText(word, 1) }
            withTimeout(5_000) { while (withContext(Dispatchers.Main) { c.view.composing == null || c.view.editableText.substring(at, at + word.length) != word }) delay(20) }
            delay(200)
            withContext(Dispatchers.Main) {
                val e = c.view.editableText
                assertTrue("$what: the composed \"$word\" is underlined", c.view.composing.let { it != null && e.getSpanStart(it) == at && e.getSpanEnd(it) == at + word.length })
                assertTrue("$what: the composed \"$word\" keeps its row's ${rowLook.simpleName}", e.getSpans(at, at + word.length, rowLook).any { e.getSpanStart(it) <= at && e.getSpanEnd(it) >= at + word.length })
            }
        }
        textFirstIme(c) { commitText("abcd", 1) }
        withTimeout(5_000) { while (withContext(Dispatchers.Main) { c.view.composing != null }) delay(20) }
        assertNull("$what: no underline once committed", withContext(Dispatchers.Main) { c.view.composing })
        withTimeout(5_000) { while (!(c.sourceText() ?: "").contains(saved)) delay(20) }
        assertTrue("$what: the source holds \"$saved\"", (c.sourceText() ?: "").contains(saved))
        assertRendersAsFresh(c, "$what, committed")
    }

    private suspend fun offset(c: TextFirstController, text: String, plus: Int = 0) = withContext(Dispatchers.Main) { c.view.editableText.indexOf(text) + plus }

    @Test fun composingInAListItemAHeadingAndACodeLine() = textFirstSession(note) { c ->
        ready(c)
        composeAt(c, offset(c, "item one", 8), "list item end", TfList::class.java, "- item oneabcd\n")
        composeAt(c, offset(c, "Title here", 10), "heading end", TfHeading::class.java, "# Title hereabcd\n")
        composeAt(c, offset(c, "Title"), "heading start", TfHeading::class.java, "# abcdTitle hereabcd\n")
        composeAt(c, offset(c, "= 1", 3), "code line end", TfCodeBlock::class.java, "const a = 1abcd\n")
    }

    /** A composed run the engine restyles: "# " typed while composing at an empty line's start makes it a heading. */
    @Test fun composingAHeadingMarkerAtALinesStart() = textFirstSession("intro\n\n\n\nend\n") { c ->
        ready(c)
        val at = offset(c, "intro", 7)
        c.select(at)
        withTimeout(5_000) { while (withContext(Dispatchers.Main) { c.view.selectionStart != at }) delay(20) }
        for (word in listOf("#", "# ", "# Hi")) {
            textFirstIme(c) { setComposingText(word, 1) }
            delay(300)
        }
        textFirstIme(c) { commitText("# Hi", 1) }
        withTimeout(5_000) { while (!(c.sourceText() ?: "").contains("# Hi")) delay(20) }
        withTimeout(5_000) { while (withContext(Dispatchers.Main) { c.view.composing != null }) delay(20) }
        assertRendersAsFresh(c, "a heading composed at a line's start")
        assertTrue("the line is a heading", withContext(Dispatchers.Main) { c.view.editableText.let { e -> e.getSpans(0, e.length, TfHeading::class.java).isNotEmpty() } })
    }
}
