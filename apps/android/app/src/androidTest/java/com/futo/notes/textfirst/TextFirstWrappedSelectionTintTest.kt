package com.futo.notes.textfirst

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Mason (S23, job 13 A1): a selected wrapped list row's second row was tinted from the note's left margin, left of the
 * hanging indent where no text is. Every row of a selection is tinted over its own text, from where that row starts.
 */
class TextFirstWrappedSelectionTintTest {
    private class Shots(val view: TextFirstEditText, val plain: Bitmap, val selected: Bitmap) {
        /** Changed pixels in the rectangle, in view coordinates. */
        fun tinted(left: Int, top: Int, right: Int, bottom: Int): Int {
            var count = 0
            for (y in maxOf(0, top) until minOf(plain.height, bottom)) for (x in maxOf(0, left) until minOf(plain.width, right)) {
                val a = plain.getPixel(x, y); val b = selected.getPixel(x, y)
                if (maxOf(Math.abs(Color.red(a) - Color.red(b)), Math.abs(Color.green(a) - Color.green(b)), Math.abs(Color.blue(a) - Color.blue(b))) > 24) count++
            }
            return count
        }
        fun rowTop(line: Int) = view.totalPaddingTop - view.scrollY + view.layout.getLineTop(line)
        fun rowBottom(line: Int) = view.totalPaddingTop - view.scrollY + view.layout.getLineBottom(line)
        fun x(offset: Int) = view.totalPaddingLeft + view.layout.getPrimaryHorizontal(offset).toInt()
    }

    /** The note rendered plain, then with [start, end) selected. */
    private suspend fun shots(c: TextFirstController, start: Int, end: Int): Shots {
        val view = c.view
        withContext(Dispatchers.Main) { view.isCursorVisible = false; view.isFocusableInTouchMode = true; view.requestFocus() }
        withTimeout(5_000) { while (view.layout == null) delay(20) }
        c.select(0)
        c.sourceText()
        delay(300)
        suspend fun render(): Bitmap = withContext(Dispatchers.Main) {
            Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888).also { Canvas(it).apply { drawColor(Color.WHITE); view.draw(this) } }
        }
        val plain = render()
        c.select(start, end)
        withTimeout(5_000) { while (view.selectionStart != start || view.selectionEnd != end) delay(20) }
        delay(300)
        return Shots(view, plain, render())
    }

    /** The row [row]'s selection is tinted over its text and nothing left of where each of its wrapped rows starts. */
    private fun textOnly(note: String, row: String) = textFirstSession(note) { c ->
        val e = c.view.editableText
        val start = e.indexOf(row)
        val end = e.indexOf('\n', start)
        val s = shots(c, start, end)
        val l = c.view.layout
        val first = l.getLineForOffset(start)
        val last = l.getLineForOffset(end)
        assertTrue("the fixture wraps over three rows", last >= first + 2)
        for (line in first..last) {
            val textLeft = s.x(l.getLineStart(line))
            val inset = c.view.style.dp(2f).toInt()
            // The first row's left is its marker, tinted with the line (drawListSelection); a wrapped row's left is margin.
            if (line > first) assertEquals("row ${line - first + 1} tinted left of its text", 0, s.tinted(c.view.totalPaddingLeft, s.rowTop(line) + inset, textLeft - 2, s.rowBottom(line) - inset))
            val middle = s.x((l.getLineStart(line) + l.getLineVisibleEnd(line)) / 2)
            assertTrue("row ${line - first + 1} is tinted over its text", s.tinted(middle - 4, s.rowTop(line) + inset, middle + 4, s.rowBottom(line) - inset) > 0)
        }
    }

    private val wrapping = " that is long enough to wrap onto a second and a third visual line on a phone screen, under its marker"

    @Test fun aWrappedNestedTask() = textOnly("- [ ] Open task\n  - [ ] Nested task$wrapping\n\nend", "Nested task")

    @Test fun aWrappedBullet() = textOnly("- Bullet$wrapping\n\nend", "Bullet")

    @Test fun aWrappedNumberedItem() = textOnly("10. Numbered$wrapping\n\nend", "Numbered")

    @Test fun aWrappedQuote() = textOnly("> Quote$wrapping\n\nend", "Quote")

    /** Sol review, job 14 (8): a long word wrapped hard ends its row where the next starts; its tint stops at the text. */
    @Test fun aLongWordWrappedHardInANestedList() = textOnly("- a\n  - Word ${"x".repeat(160)}\n\nend", "Word")

    /** Sol review (9): a selection from the end of "hello" into the next row tints nothing over "hello". */
    @Test fun aSelectedLineBreakLeavesTheRowsTextUntinted() = textFirstSession("hello\nnext line\n\nend") { c ->
        val e = c.view.editableText
        val s = shots(c, e.indexOf("hello") + 5, e.indexOf("next") + 4)
        val line = c.view.layout.getLineForOffset(0)
        assertEquals("pixels tinted over hello", 0, s.tinted(s.x(0), s.rowTop(line) + 4, s.x(5) - 2, s.rowBottom(line) - 4))
    }

    /** Sol review (10): a selection reaching a table keeps the wrapped rows above it off their margin. */
    @Test fun aSelectionIntoATableKeepsWrappedRowsOffTheMargin() = textFirstSession("- Bullet$wrapping\n\n| a | b |\n| - | - |\n| c | d |\n\nend") { c ->
        val e = c.view.editableText
        val s = shots(c, e.indexOf("Bullet"), e.indexOf("d |") + 1)
        val l = c.view.layout
        val first = l.getLineForOffset(e.indexOf("Bullet"))
        for (line in first + 1..first + 2) {
            assertEquals("wrapped row ${line - first + 1} tinted left of its text", 0,
                s.tinted(c.view.totalPaddingLeft, s.rowTop(line) + 4, s.x(l.getLineStart(line)) - 2, s.rowBottom(line) - 4))
        }
        // Verifier (job 13, A1): the empty line before the table was tinted across the note's width.
        val blank = l.getLineForOffset(e.indexOf("| a"))  - 1
        val wide = c.view.width / 4
        assertEquals("the empty line's tint past a space's width", 0, s.tinted(c.view.totalPaddingLeft + wide, s.rowTop(blank) + 4, c.view.width - c.view.totalPaddingRight, s.rowBottom(blank) - 4))
    }

    /** Sol review (7): a selection that wrapped and then fits one row (a wider window) still shows its tint. */
    @Test fun aSelectionStillShowsAfterTheWindowWidens() = textFirstSession("A short paragraph to select across\n\nend") { c ->
        val view = c.view
        val e = view.editableText
        val end = e.indexOf('\n')
        withContext(Dispatchers.Main) { view.layoutParams = view.layoutParams.apply { width = view.width / 3 } }
        withTimeout(5_000) { while (view.layout == null || view.layout.getLineForOffset(end) == 0) delay(20) }
        val s = shots(c, 0, end)
        assertTrue("the narrow note tints the selection", s.tinted(0, 0, view.width, view.height) > 0)
        withContext(Dispatchers.Main) { view.layoutParams = view.layoutParams.apply { width = android.view.ViewGroup.LayoutParams.MATCH_PARENT } }
        withTimeout(5_000) { while (view.layout.getLineForOffset(end) != 0) delay(20) }
        delay(300)
        suspend fun render(): Bitmap = withContext(Dispatchers.Main) {
            Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888).also { Canvas(it).apply { drawColor(Color.WHITE); view.draw(this) } }
        }
        val selected = render()
        c.select(end)
        withTimeout(5_000) { while (view.selectionStart != end) delay(20) }
        delay(300)
        val wide = Shots(view, render(), selected)
        assertTrue("the one-row selection is tinted", wide.tinted(0, wide.rowTop(0), view.width, wide.rowBottom(0)) > 0)
    }
}
