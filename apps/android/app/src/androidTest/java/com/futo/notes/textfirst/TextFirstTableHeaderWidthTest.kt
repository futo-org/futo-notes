package com.futo.notes.textfirst

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertTrue
import org.junit.Test

/** A table narrower than the note: the header's fill ends with its last column, as the body row's cells do. */
class TextFirstTableHeaderWidthTest {
    @Test fun aNarrowTablesHeaderFillEndsAtItsLastColumn() = textFirstSession("intro\n\n| a | b |\n| - | - |\n| c | d |\n\nafter") { c ->
        val view = c.view
        withTimeout(5_000) { while (view.layout == null) delay(20) }
        c.sourceText()
        delay(300)
        val (fillRight, tableRight) = withContext(Dispatchers.Main) {
            val e = view.editableText
            val header = e.getSpans(0, e.length, TfTableRow::class.java).single { it.row.header }
            val l = view.layout
            val line = l.getLineForOffset(e.getSpanStart(header))
            view.style.codeBackground = Color.rgb(230, 222, 205)
            val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
            Canvas(bitmap).apply { drawColor(Color.WHITE); view.draw(this) }
            val y = view.totalPaddingTop - view.scrollY + (l.getLineTop(line) + l.getLineBottom(line)) / 2
            val fill = view.style.codeBackground
            val right = (0 until bitmap.width).last { bitmap.getPixel(it, y) == fill } + 1
            right to (view.totalPaddingLeft + header.row.columns * header.cellWidth).toInt()
        }
        // The last column's 1 dp border is centred on the table's edge and covers the fill's last pixels.
        val border = c.view.style.dp(1f)
        assertTrue("the header's fill ends at $fillRight, the table at $tableRight", fillRight <= tableRight && fillRight >= tableRight - border)
    }

    /** A selection ending on a row has its end (and its handle) at the row's end: the table's right edge, not the note's. */
    @Test fun aNarrowTablesRowEndsAtItsLastColumn() = textFirstSession("intro\n\n| a | b |\n| - | - |\n| c | d |\n\nafter") { c ->
        val view = c.view
        withTimeout(5_000) { while (view.layout == null) delay(20) }
        c.sourceText()
        val (rowEnd, tableRight) = withContext(Dispatchers.Main) {
            val e = view.editableText
            val header = e.getSpans(0, e.length, TfTableRow::class.java).single { it.row.header }
            view.layout.getPrimaryHorizontal(e.getSpanEnd(header)) to header.row.columns * header.cellWidth
        }
        assertTrue("the row ends at $rowEnd, the table at $tableRight", Math.abs(rowEnd - tableRight) <= 1f)
    }
}
