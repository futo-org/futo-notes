package com.futo.notes.textfirst

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Sol review (batch 1, 13): a tap on a missing wikilink was lost while a word was still being composed. A tap on a note
 * object during composition commits the word and then does what the tap does: a wikilink, a web link, a checkbox.
 */
class TextFirstComposingTapTest {
    private val word = "abcdefghijklmnopqrst"

    /** A word of [word] being composed at the note's start, then the view's point at the middle of display [offset]'s row. */
    private suspend fun composeThenPointAt(view: TextFirstEditText, offset: () -> Int): Pair<Float, Float> {
        withContext(Dispatchers.Main) {
            view.isFocusableInTouchMode = true
            view.requestFocus()
            view.setSelection(0)
        }
        delay(300)
        withContext(Dispatchers.Main) { view.onCreateInputConnection(android.view.inputmethod.EditorInfo())!!.setComposingText(word, 1) }
        withTimeout(5_000) { while (!view.editableText.toString().startsWith(word)) delay(20) }
        delay(300)
        return withContext(Dispatchers.Main) {
            val at = offset()
            val line = view.layout.getLineForOffset(at)
            (view.totalPaddingLeft + view.layout.getPrimaryHorizontal(at) + 6f) to
                (view.totalPaddingTop - view.scrollY + view.layout.getLineBaseline(line) - view.paint.textSize / 3f)
        }
    }

    @Test fun aMissingWikilinkTappedWhileComposingIsFollowed() = textFirstSession("intro\n\n[[Missing]]") { c ->
        val view = c.view
        withTimeout(5_000) { while (view.layout == null || view.editableText.getSpans(0, view.length(), TfWikilink::class.java).isEmpty()) delay(20) }
        val (x, y) = composeThenPointAt(view) { view.editableText.getSpanStart(view.editableText.getSpans(0, view.length(), TfWikilink::class.java).first()) }
        val followed = mutableListOf<WikilinkDestination>()
        view.onOpenWikilink = { followed.add(it) }
        withContext(Dispatchers.Main) { tapNoteAt(view, x, y) }
        withTimeout(5_000) { while (followed.isEmpty()) delay(20) }
        assertEquals(listOf(WikilinkDestination.Missing("Missing")), followed)
        assertTrue("the composed word is in the note", c.sourceText()!!.startsWith(word))
    }

    @Test fun aWebLinkTappedWhileComposingOpens() = textFirstSession("intro\n\n[web](https://example.com/x)") { c ->
        val view = c.view
        withTimeout(5_000) { while (view.layout == null) delay(20) }
        val (x, y) = composeThenPointAt(view) { view.editableText.toString().indexOf("web") }
        val opened = mutableListOf<String>()
        withContext(Dispatchers.Main) { view.onOpenUrl = { opened.add(it) } }
        withContext(Dispatchers.Main) { tapNoteAt(view, x, y) }
        withTimeout(5_000) { while (opened.isEmpty()) delay(20) }
        assertEquals(listOf("https://example.com/x"), opened)
    }

    @Test fun aCheckboxTappedWhileComposingToggles() = textFirstSession("intro\n\n- [ ] task") { c ->
        val view = c.view
        withTimeout(5_000) { while (view.layout == null) delay(20) }
        val (x, y) = composeThenPointAt(view) { view.editableText.toString().indexOf("task") }
        val boxX = x - 6f - view.style.listIndent / 2f
        withContext(Dispatchers.Main) { tapNoteAt(view, boxX, y) }
        withTimeout(5_000) { while (!c.sourceText()!!.contains("- [x] task")) delay(20) }
        assertTrue("the composed word is in the note", c.sourceText()!!.startsWith(word))
    }
}
