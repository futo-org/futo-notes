package com.futo.notes.textfirst

import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Mason (S23, job 13 A2): a retap on the empty last line, scrolled half under the note's bottom edge, left a caret
 * clipped to a stub. A tap that leaves the caret where it was still shows its whole line.
 */
class TextFirstRetapRevealTest {
    @Test fun aRetapOnAHalfHiddenLineShowsItsWholeCaret() = textFirstSession((1..60).joinToString("\n") { "line $it" } + "\nLast line #end\n") { c ->
        val view = c.view
        view.isFocusableInTouchMode = true
        view.requestFocus()
        withTimeout(5_000) { while (view.layout == null) delay(20) }
        val last = view.length() - 1
        c.select(last)
        withTimeout(5_000) { while (view.selectionStart != last) delay(20) }
        delay(300)
        val l = view.layout
        val line = l.getLineForOffset(last)
        val visibleBottom = view.height - view.totalPaddingBottom
        // The line's top third on screen, the rest under the note's bottom edge.
        val third = (l.getLineBottom(line) - l.getLineTop(line)) / 3
        view.scrollTo(0, view.totalPaddingTop + l.getLineTop(line) + third - visibleBottom)
        delay(300)
        assertTrue("the line is half hidden first", view.totalPaddingTop - view.scrollY + l.getLineBottom(line) > visibleBottom)
        tapNoteAt(view, view.totalPaddingLeft + 10f, view.totalPaddingTop - view.scrollY + l.getLineTop(line) + third / 2f)
        delay(500)
        assertEquals("the tap moved the caret", last, view.selectionStart)
        val bottom = view.totalPaddingTop - view.scrollY + l.getLineBottom(line)
        assertTrue("the caret's line ends at $bottom, under the note's edge at $visibleBottom", bottom <= visibleBottom + 1)
    }
}
