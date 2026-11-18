package com.futo.notes.textfirst

import android.graphics.Bitmap
import android.graphics.Canvas
import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

/** P179 (!300 cb 591-597): a selection run in code is rounded where it stops mid-text. */
class TextFirstCodeSelectionCornerTest {
    @Test fun aRunStoppingMidTextHasARoundedCorner() = textFirstSession("intro\n\n```js\nconst first = 1\nconst second = 2\n```\n\nend") { c ->
        val view = c.view
        view.isFocusableInTouchMode = true
        view.requestFocus()
        withTimeout(5_000) { while (view.layout == null) delay(20) }
        val e = view.editableText
        val start = e.indexOf("first")
        val end = e.indexOf("second") + 3
        val l = view.layout
        val line = l.getLineForOffset(start)
        val (top, _) = view.textRowBand(l, e, line)
        val x = view.totalPaddingLeft + l.getPrimaryHorizontal(start).toInt()
        val y = view.totalPaddingTop - view.scrollY + top.toInt()
        val inside = view.totalPaddingTop - view.scrollY + l.getLineBaseline(line) - 6
        fun pixels(): Pair<Int, Int> {
            val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
            view.draw(Canvas(bitmap))
            return bitmap.getPixel(x + 1, y + 1) to bitmap.getPixel(x + 4, inside)
        }
        val (cornerBefore, insideBefore) = pixels()
        c.select(start, end)
        withTimeout(5_000) { while (view.selectionEnd != end) delay(20) }
        delay(300)
        val (corner, insideSelected) = pixels()
        assertNotEquals("the run is not painted", insideBefore, insideSelected)
        assertEquals("the run's corner where it starts mid-text is square", cornerBefore, corner)
    }

    /** On a right-to-left code line the run starts on the right, so that is the corner that is rounded. */
    @Test fun aRightToLeftRunIsRoundedOnTheRight() = textFirstSession("intro\n\n```txt\nשלום עולם יפה\nעוד שורה כאן\n```\n\nend") { c ->
        val view = c.view
        view.isFocusableInTouchMode = true
        view.requestFocus()
        withTimeout(5_000) { while (view.layout == null) delay(20) }
        val e = view.editableText
        val start = e.indexOf("עולם")
        val end = e.indexOf("שורה")
        val l = view.layout
        val line = l.getLineForOffset(start)
        val (top, _) = view.textRowBand(l, e, line)
        val x = view.totalPaddingLeft + l.getPrimaryHorizontal(start).toInt()
        val y = view.totalPaddingTop - view.scrollY + top.toInt()
        val inside = view.totalPaddingTop - view.scrollY + l.getLineBaseline(line) - 6
        fun pixels(): Pair<Int, Int> {
            val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
            view.draw(Canvas(bitmap))
            return bitmap.getPixel(x - 2, y + 1) to bitmap.getPixel(x - 30, inside)
        }
        val (cornerBefore, textBefore) = pixels()
        c.select(start, end)
        withTimeout(5_000) { while (view.selectionEnd != end) delay(20) }
        delay(300)
        val (corner, text) = pixels()
        assertNotEquals("the run is not painted over its text, left of where it starts", textBefore, text)
        assertEquals("the run's start corner, on the right, is square", cornerBefore, corner)
    }
}
