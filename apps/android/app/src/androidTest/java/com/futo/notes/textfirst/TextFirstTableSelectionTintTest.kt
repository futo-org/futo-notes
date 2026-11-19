package com.futo.notes.textfirst

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Rect
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * A selection over table rows tints the selected rows' cells, clipped to the table's columns; nothing is painted past the
 * last column, and rows the selection does not touch stay as they were.
 */
class TextFirstTableSelectionTintTest {
    private val note = "intro line\n\n| h1 | h2 |\n| - | - |\n| c1 | c2 |\n| d1 | d2 |\n\nend"

    private suspend fun render(view: TextFirstEditText): Bitmap = withContext(Dispatchers.Main) {
        Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888).also { Canvas(it).apply { drawColor(Color.WHITE); view.draw(this) } }
    }

    private fun changed(before: Int, after: Int): Boolean =
        maxOf(Math.abs(Color.red(before) - Color.red(after)), Math.abs(Color.green(before) - Color.green(after)), Math.abs(Color.blue(before) - Color.blue(after))) > 24

    /** The rect selecting [from, to) changes, against the cells of the rows named by their first cell's text. */
    private fun check(from: (CharSequence) -> Int, to: (CharSequence) -> Int, rows: List<String>, scroll: Float = 0f) = textFirstSession(note) { c ->
        val view = c.view
        withContext(Dispatchers.Main) { view.style.codeBackground = Color.rgb(230, 222, 205); view.isCursorVisible = false; view.isFocusableInTouchMode = true; view.requestFocus() }
        withTimeout(5_000) { while (view.layout == null) delay(20) }
        val e = view.editableText
        withContext(Dispatchers.Main) { e.getSpans(0, e.length, TfTableRow::class.java).forEach { it.scroll.x = scroll }; view.invalidate() }
        c.select(0)
        c.sourceText()
        delay(300)
        val plain = render(view)
        c.select(from(e), to(e))
        withTimeout(5_000) { while (view.selectionStart != from(e) || view.selectionEnd != to(e)) delay(20) }
        delay(300)
        val selected = render(view)
        val expected = withContext(Dispatchers.Main) {
            val l = view.layout
            val spans = e.getSpans(0, e.length, TfTableRow::class.java).filter { span -> rows.any { e.substring(e.getSpanStart(span), e.getSpanEnd(span)).contains(it) } }
            val top = spans.minOf { l.getLineTop(l.getLineForOffset(e.getSpanStart(it))) }
            val bottom = spans.maxOf { l.getLineBottom(l.getLineForOffset(e.getSpanStart(it))) }
            val table = spans.first()
            val left = view.totalPaddingLeft
            val right = minOf(left + (table.row.columns * table.cellWidth - table.scroll.x).toInt(), view.width - view.totalPaddingRight)
            Rect(left, view.totalPaddingTop + top, right, view.totalPaddingTop + bottom)
        }
        // Only the table's band of the screen: a selection reaching into the paragraph above tints that row too.
        val band = Rect(0, expected.top, plain.width, expected.bottom)
        val tinted = Rect(plain.width, plain.height, -1, -1)
        for (y in band.top until band.bottom) for (x in 0 until plain.width) if (changed(plain.getPixel(x, y), selected.getPixel(x, y))) tinted.union(x, y)
        val found = Rect(tinted.left, tinted.top, tinted.right + 1, tinted.bottom + 1)
        val tolerance = view.style.dp(2f).toInt()
        val near = Math.abs(found.left - expected.left) <= tolerance && Math.abs(found.right - expected.right) <= tolerance &&
            Math.abs(found.top - expected.top) <= tolerance && Math.abs(found.bottom - expected.bottom) <= tolerance
        assertEquals("the tint over $rows is ${found}, the rows' cells are $expected", true, near)
    }

    private fun lineOf(text: String): (CharSequence) -> Int = { it.indexOf(text) - 2 }
    private fun lineEnd(text: String): (CharSequence) -> Int = { it.indexOf('\n', it.indexOf(text)) }

    @Test fun theHeaderRowOnly() = check(lineOf("h1"), lineEnd("h1"), listOf("h1"))

    @Test fun oneBodyRow() = check(lineOf("c1"), lineEnd("c1"), listOf("c1"))

    @Test fun allRows() = check(lineOf("h1"), lineEnd("d1"), listOf("h1", "c1", "d1"))

    @Test fun fromTheParagraphAboveIntoTheTable() = check({ it.indexOf("line") }, lineEnd("c1"), listOf("h1", "c1"))

    @Test fun aTableScrolledSideways() = check(lineOf("h1"), lineEnd("d1"), listOf("h1", "c1", "d1"), scroll = 200f)
}
