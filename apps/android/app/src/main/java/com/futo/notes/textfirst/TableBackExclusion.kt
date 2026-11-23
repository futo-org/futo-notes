package com.futo.notes.textfirst

import android.graphics.Rect

/**
 * A wide table pans sideways from anywhere on it, edges included, and a drag from the screen's edge is the system's
 * Back gesture. Over the rows of a table that can pan, the strip at each edge of the note is the table's: the system
 * leaves it to the app (it caps what it honours at 200 dp of height per edge).
 */
internal class TableBackExclusion(private val note: TextFirstEditText) {
    private var key = 0L

    /** Called every frame; recomputes only when what shows or where it shows has changed. */
    fun update() {
        val l = note.layout
        val e = note.editableText
        if (l == null || e == null || note.width == 0) return
        val next = (((note.scrollY * 31L + note.height) * 31 + note.width) * 31 + note.appliedSeq) * 31 + l.height
        if (next == key) return
        key = next
        val strip = (EDGE_DP * note.resources.displayMetrics.density).toInt()
        val rects = ArrayList<Rect>(0)
        val top = (note.scrollY - note.totalPaddingTop).coerceAtLeast(0)
        val bottom = (note.scrollY + note.height - note.totalPaddingTop).coerceAtMost(l.height)
        if (bottom > top) {
            var line = l.getLineForVertical(top)
            val last = l.getLineForVertical(bottom - 1)
            while (line <= last) {
                val at = l.getLineStart(line)
                val row = e.getSpans(at, at, TfTableRow::class.java).firstOrNull { e.getSpanStart(it) == at }
                if (row != null && row.columns * row.cellWidth > row.viewportWidth) {
                    val y0 = note.totalPaddingTop + l.getLineTop(line) - note.scrollY
                    val y1 = note.totalPaddingTop + l.getLineBottom(line) - note.scrollY
                    rects += Rect(0, y0, strip, y1)
                    rects += Rect(note.width - strip, y0, note.width, y1)
                }
                line++
            }
        }
        androidx.core.view.ViewCompat.setSystemGestureExclusionRects(note, rects)
    }

    private companion object {
        const val EDGE_DP = 32f
    }
}
