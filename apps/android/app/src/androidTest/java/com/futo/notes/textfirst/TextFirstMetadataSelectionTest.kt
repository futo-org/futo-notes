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

/** Tester (round 2, F2): a selection over the front matter (Select All) drew no tint on its card, though Copy takes it. */
class TextFirstMetadataSelectionTest {
    private val note = "---\nstatus: multi\ntags: [a, b]\nauthor: tester\n---\nBody line one.\n\nBody line two.\n"

    /** Round 3 (N3): the engine gives each front-matter row its own span; one card stands behind all of them. */
    @Test fun frontMatterOfThreeLinesHasOneCardBehindAllOfIt() = textFirstSession(note) { c ->
        val view = c.view
        withTimeout(5_000) { while (view.layout == null) delay(20) }
        delay(300)
        val (card, page) = withContext(Dispatchers.Main) {
            val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
            Canvas(bitmap).apply { drawColor(Color.WHITE); view.draw(this) }
            val l = view.layout
            // In the card's left bar, which only the card draws.
            fun past(word: String): Int {
                val line = l.getLineForOffset(view.editableText.indexOf(word))
                return bitmap.getPixel(view.totalPaddingLeft + view.style.dp(1.5f).toInt(), view.totalPaddingTop + (l.getLineTop(line) + l.getLineBottom(line)) / 2)
            }
            listOf(past("status"), past("tags"), past("author")) to past("Body line one").also { bitmap.recycle() }
        }
        assertTrue("the card is drawn on the first row", card[0] != page)
        assertEquals("one card behind every front-matter row", listOf(card[0], card[0], card[0]), card)
    }

    @Test fun aSelectionOverTheFrontMatterTintsItsCard() = textFirstSession(note) { c ->
        val view = c.view
        withTimeout(5_000) { while (view.layout == null) delay(20) }
        suspend fun cardRow(): IntArray = withContext(Dispatchers.Main) {
            val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
            Canvas(bitmap).apply { drawColor(Color.WHITE); view.draw(this) }
            val l = view.layout
            val line = l.getLineForOffset(view.editableText.indexOf("author") + 2)
            val top = view.totalPaddingTop - view.scrollY + l.getLineTop(line)
            val height = l.getLineBottom(line) - l.getLineTop(line)
            IntArray(bitmap.width * height).also { bitmap.getPixels(it, 0, bitmap.width, 0, top, bitmap.width, height); bitmap.recycle() }
        }
        val plain = cardRow()
        withContext(Dispatchers.Main) { view.onTextContextMenuItem(android.R.id.selectAll) }
        withTimeout(5_000) { while (withContext(Dispatchers.Main) { view.selectionStart != 0 || view.selectionEnd < view.length() - 2 }) delay(20) }
        delay(300)
        val selected = cardRow()
        val changed = plain.indices.count { plain[it] != selected[it] }
        assertTrue("the card's row carries the selection's tint ($changed pixels changed)", changed > plain.size / 20)
    }
}
