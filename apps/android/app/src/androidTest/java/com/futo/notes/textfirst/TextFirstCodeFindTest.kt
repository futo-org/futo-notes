package com.futo.notes.textfirst

import android.graphics.Bitmap
import android.graphics.Canvas
import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

/** Area 15 verifier (P310): a match on a block's first code line is painted on its row, not over the header. */
class TextFirstCodeFindTest {
    @Test fun aMatchOnTheFirstCodeLineLeavesTheHeader() = textFirstSession("intro\n\n```python name:widget.py\nkiwi = 1\n```\n\nend") { c ->
        val view = c.view
        withTimeout(5_000) { while (view.layout == null) delay(20) }
        val match = view.editableText.indexOf("kiwi")
        val l = view.layout
        val line = l.getLineForOffset(match)
        val x = view.totalPaddingLeft + ((l.getPrimaryHorizontal(match) + l.getPrimaryHorizontal(match + 4)) / 2).toInt()
        val headerY = view.totalPaddingTop - view.scrollY + l.getLineTop(line) + (view.style.codeHeaderHeight / 2).toInt()
        val textY = view.totalPaddingTop - view.scrollY + l.getLineBaseline(line) - 4
        suspend fun pixels(): Pair<Int, Int> {
            delay(300)
            val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
            view.draw(Canvas(bitmap))
            return bitmap.getPixel(x, headerY) to bitmap.getPixel(x, textY)
        }
        val (headerBefore, textBefore) = pixels()
        c.findSetQuery("kiwi")
        val (headerFound, textFound) = pixels()
        assertNotEquals("the match was not painted", textBefore, textFound)
        assertEquals("the match's band reached into the header", headerBefore, headerFound)
    }
}
