package com.futo.notes.textfirst

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Mason (S23, job 13 A7): "Tapping a checkmark puts me at the top of the note. Not keeping scroll position." A tap on
 * a task's checkbox toggles it and moves no caret, so the note stays where the reader had it.
 */
class TextFirstCheckboxScrollTest {
    private val note = (1..80).joinToString("\n") { "line $it of prose above" } + "\n\n- [ ] Task one\n- [ ] Task two\n\n" +
        (1..40).joinToString("\n") { "line $it after" } + "\n"

    private fun tapsTheBox(focused: Boolean, caretAtTop: Boolean, frontMatter: Boolean = false) =
        textFirstSession(if (frontMatter) "---\nstatus: draft\n---\n$note" else note) { c ->
        val view = c.view
        withContext(Dispatchers.Main) { view.isFocusableInTouchMode = true; if (focused) view.requestFocus() else view.clearFocus() }
        withTimeout(5_000) { while (view.layout == null) delay(20) }
        if (caretAtTop) {
            c.select(0)
            withTimeout(5_000) { while (view.selectionStart != 0) delay(20) }
        }
        val e = view.editableText
        val task = e.indexOf("Task two")
        val l = view.layout
        val line = l.getLineForOffset(task)
        // The task in the middle of the screen, the note scrolled far from its top and from the caret.
        view.scrollTo(0, view.totalPaddingTop + l.getLineTop(line) - view.height / 2)
        delay(500)
        val before = view.scrollY
        val boxX = view.totalPaddingLeft + l.getPrimaryHorizontal(task) - view.style.listIndent / 2f
        val boxY = view.totalPaddingTop - view.scrollY + (l.getLineTop(line) + l.getLineBottom(line)) / 2f
        tapNoteAt(view, boxX, boxY)
        withTimeout(5_000) { while (!c.sourceText()!!.contains("- [x] Task two")) delay(20) }
        delay(800)
        assertEquals("the note's scroll after the checkbox tap", before, view.scrollY)
    }

    @Test fun withTheCaretFarAboveItKeepsTheScroll() = tapsTheBox(focused = true, caretAtTop = true)

    @Test fun withNoFocusKeepsTheScroll() = tapsTheBox(focused = false, caretAtTop = false)

    /**
     * As on the S23's Editor demo: a note with front matter just opened, no caret placed. The session keeps a caret out
     * of the front matter, so a view that started at 0 had the toggle move its caret there, revealed at the note's top.
     */
    @Test fun inANoteWithFrontMatterJustOpenedKeepsTheScroll() = tapsTheBox(focused = false, caretAtTop = false, frontMatter = true)
}
