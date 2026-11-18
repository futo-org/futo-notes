package com.futo.notes.textfirst

import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * FUTO Keyboard's Backspace over a selection, as it sends it (recorded with the TextFirstIme trace): collapse to the
 * selection's end, read, finish composing, delete the selection's length backwards. On an object selected whole (an
 * image, a code block) that removes the object, never the text before it.
 */
class TextFirstObjectKeyboardDeleteTest {
    private suspend fun futoBackspace(c: TextFirstController, start: Int, end: Int) {
        textFirstIme(c) {
            setSelection(end, end)
            getTextBeforeCursor(1040, 0)
            finishComposingText()
            deleteSurroundingText(end - start, 0)
        }
    }

    @Test fun backspaceOverATappedImageRemovesTheImageOnly() = textFirstSession("before ![inline](missing.png) after\n\nnext") { c ->
        val view = c.view
        view.isFocusableInTouchMode = true
        view.requestFocus()
        withTimeout(5_000) { while (view.layout == null) delay(20) }
        val e = view.editableText
        val image = e.getSpans(0, e.length, TfImage::class.java).single()
        val start = e.getSpanStart(image)
        val end = e.getSpanEnd(image)
        val l = view.layout
        val x = view.totalPaddingLeft + l.getPrimaryHorizontal(start) + 20f
        val y = view.totalPaddingTop - view.scrollY + l.getLineBaseline(l.getLineForOffset(start)) - 20f
        tapNoteAt(view, x, y)
        withTimeout(5_000) { while (view.selectionStart != start || view.selectionEnd != end) delay(20) }
        delay(200)
        assertEquals(start to end, view.selectedObject)
        futoBackspace(c, start, end)
        withTimeout(5_000) { while (c.sourceText() == "before ![inline](missing.png) after\n\nnext") delay(20) }
        assertEquals("before  after\n\nnext", c.sourceText())
    }

    @Test fun backspaceOverASelectedBlockRemovesTheBlockOnly() = textFirstSession("before\n\n```js\nconst a = 1\n```\n\nafter") { c ->
        val view = c.view
        view.isFocusableInTouchMode = true
        view.requestFocus()
        val code = view.editableText.indexOf("const")
        withTimeout(5_000) { while (view.codeChrome.areaOf(code, CodeBlockAction.SELECT_BLOCK) == null) delay(20) }
        val area = view.codeChrome.areaOf(code, CodeBlockAction.SELECT_BLOCK)!!
        tapNoteAt(view, view.totalPaddingLeft + area.centerX(), view.totalPaddingTop - view.scrollY + area.centerY())
        withTimeout(5_000) { while (view.selectedCodeBlock == null) delay(20) }
        val (start, end) = view.selectedCodeBlock!!
        futoBackspace(c, start, end)
        withTimeout(5_000) { while (c.sourceText()!!.contains("const")) delay(20) }
        assertEquals("before\n\n\n\nafter", c.sourceText())
    }

    /** The same delete inside a batch with no commit after it is a Backspace too, the image going whole. */
    @Test fun aBatchedDeleteWithNoCommitRemovesTheImage() = textFirstSession("before ![inline](missing.png) after") { c ->
        val view = c.view
        view.isFocusableInTouchMode = true
        view.requestFocus()
        withTimeout(5_000) { while (view.layout == null) delay(20) }
        val e = view.editableText
        val image = e.getSpans(0, e.length, TfImage::class.java).single()
        val start = e.getSpanStart(image)
        val end = e.getSpanEnd(image)
        c.select(start, end)
        withTimeout(5_000) { while (view.selectedObject != (start to end)) delay(20) }
        textFirstIme(c) {
            beginBatchEdit()
            setSelection(end, end)
            deleteSurroundingText(end - start, 0)
            endBatchEdit()
        }
        withTimeout(5_000) { while (c.sourceText()!!.contains("missing")) delay(20) }
        assertEquals("before  after", c.sourceText())
    }
}
