package com.futo.notes.textfirst

import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Mason, 2026-11-17: "I can click 'between' lines and the caret will land on the end of the line. This is
 * unacceptable ... this goes for code blocks and anywhere else." A tap anywhere in a row, its top pixel rows,
 * middle and bottom pixel rows, puts the caret at the tapped column of that row, for every kind of line.
 */
class TextFirstTapRowTest {
    private val note = "A paragraph long enough to wrap onto a second row on a phone screen, and then some more words.\n" +
        "# A heading\n" +
        "- a list item\n" +
        "> a quote line\n" +
        "```js\n" +
        "const a = 1\n" +
        "const longer = \"a code line long enough to wrap onto a second visual row here\"\n" +
        "```\n" +
        "after"

    @Test fun aTapAnywhereInARowLandsAtItsColumn() = textFirstSession(note) { c ->
        val view = c.view
        view.isFocusableInTouchMode = true
        view.requestFocus()
        withTimeout(5_000) { while (view.layout == null || view.codeChrome.areaOf(view.editableText.indexOf("const a"), CodeBlockAction.SELECT_BLOCK) == null) delay(20) }
        val misses = mutableListOf<String>()
        val l = view.layout
        val textEnd = view.length() - TextFirstEditText.END_SENTINEL.length
        for (line in 0 until l.lineCount) {
            val start = l.getLineStart(line)
            val end = l.getLineEnd(line)
            if (start >= textEnd || l.getLineMax(line) < 1f) continue
            val x = (l.getLineLeft(line) + l.getLineRight(line)) / 2f
            val expected = l.getOffsetForHorizontal(line, x)
            val top = l.getLineTop(line).toFloat()
            val bottom = l.getLineBottom(line).toFloat()
            for ((where, y) in listOf("top" to top + 1f, "middle" to (top + bottom) / 2f, "bottom" to bottom - 2f)) {
                // The header row and the skirt are the block's own parts, with their own rules.
                if (view.codeChrome.targetAt(x, y) != null) continue
                // Apart by more than the double-tap timeout, so each is a single tap, not a word or line selection.
                delay(android.view.ViewConfiguration.getDoubleTapTimeout() + 150L)
                tapNoteAt(view, view.totalPaddingLeft + x, view.totalPaddingTop - view.scrollY + y)
                delay(150)
                if (view.selectionStart != expected || view.selectionEnd != expected) {
                    misses += "line $line \"${view.editableText.substring(start, end).trim().take(24)}\" $where (y ${y.toInt()} in ${top.toInt()}..${bottom.toInt()}): caret ${view.selectionStart}..${view.selectionEnd}, expected $expected"
                }
            }
        }
        assertEquals(misses.joinToString("\n"), 0, misses.size)
    }
}
