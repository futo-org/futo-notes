package com.futo.notes.textfirst

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Mason (S23, job 13 A1): a selected wrapped list row's second row was tinted from the note's left margin, left of the
 * hanging indent where no text is. Every row of a selection is tinted over its own text, from where that row starts.
 */
class TextFirstWrappedSelectionTintTest {
    private fun changed(before: Int, after: Int): Boolean =
        maxOf(Math.abs(Color.red(before) - Color.red(after)), Math.abs(Color.green(before) - Color.green(after)), Math.abs(Color.blue(before) - Color.blue(after))) > 24

    private fun nothingLeftOfTheIndent(note: String, row: String) = textFirstSession(note) { c ->
        val view = c.view
        withContext(Dispatchers.Main) { view.isCursorVisible = false; view.isFocusableInTouchMode = true; view.requestFocus() }
        withTimeout(5_000) { while (view.layout == null) delay(20) }
        val e = view.editableText
        val start = e.indexOf(row)
        val end = e.indexOf('\n', start)
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
        val selected = render()
        val l = view.layout
        val first = l.getLineForOffset(start)
        val last = l.getLineForOffset(end)
        var tintedLeftOfText = 0
        for (line in first + 1..last) {
            // Left of the row's first character: the hanging indent, where no text is.
            val textLeft = view.totalPaddingLeft + l.getPrimaryHorizontal(l.getLineStart(line)).toInt() - 2
            for (y in view.totalPaddingTop - view.scrollY + l.getLineTop(line) + 2 until view.totalPaddingTop - view.scrollY + l.getLineBottom(line) - 2) {
                for (x in view.totalPaddingLeft until textLeft) if (changed(plain.getPixel(x, y), selected.getPixel(x, y))) tintedLeftOfText++
            }
        }
        assertEquals("pixels tinted left of the wrapped rows' text", 0, tintedLeftOfText)
    }

    private val wrapping = " that is long enough to wrap onto a second and a third visual line on a phone screen, under its marker"

    @Test fun aWrappedNestedTask() = nothingLeftOfTheIndent("- [ ] Open task\n  - [ ] Nested task$wrapping\n\nend", "Nested task")

    @Test fun aWrappedBullet() = nothingLeftOfTheIndent("- Bullet$wrapping\n\nend", "Bullet")

    @Test fun aWrappedNumberedItem() = nothingLeftOfTheIndent("10. Numbered$wrapping\n\nend", "Numbered")

    @Test fun aWrappedQuote() = nothingLeftOfTheIndent("> Quote$wrapping\n\nend", "Quote")
}
