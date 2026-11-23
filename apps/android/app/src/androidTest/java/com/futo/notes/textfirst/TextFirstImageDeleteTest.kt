package com.futo.notes.textfirst

import android.graphics.Bitmap
import android.graphics.Canvas
import android.view.KeyEvent
import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

/** Mason's desktop rules, phone form: Backspace after an image or Delete before it selects it first; a selected image is tinted. */
class TextFirstImageDeleteTest {
    private val source = "a ![gone](missing.png) b"

    private suspend fun ready(c: TextFirstController, caret: Int) {
        val view = c.view
        view.isFocusableInTouchMode = true
        view.requestFocus()
        withTimeout(5_000) { while (view.layout == null) delay(20) }
        c.select(caret)
        withTimeout(5_000) { while (view.selectionStart != caret) delay(20) }
        delay(200)
    }

    private fun imageRange(c: TextFirstController): Pair<Int, Int> {
        val e = c.view.editableText
        val image = e.getSpans(0, e.length, TfImage::class.java).single()
        return e.getSpanStart(image) to e.getSpanEnd(image)
    }

    @Test fun backspaceAfterAnImageSelectsItThenDeletesIt() = textFirstSession(source) { c ->
        val (start, end) = imageRange(c)
        ready(c, end)
        textFirstIme(c) { deleteSurroundingText(1, 0) }
        withTimeout(5_000) { while (c.view.selectionStart != start) delay(20) }
        assertEquals(start to end, c.view.selectionStart to c.view.selectionEnd)
        assertEquals(source, c.sourceText())
        textFirstIme(c) { deleteSurroundingText(1, 0) }
        withTimeout(5_000) { while (c.sourceText() == source) delay(50) }
        assertEquals("a  b", c.sourceText())
    }

    @Test fun deleteBeforeAnImageSelectsItFirst() = textFirstSession(source) { c ->
        val (start, end) = imageRange(c)
        ready(c, start)
        c.view.onKeyDown(KeyEvent.KEYCODE_FORWARD_DEL, KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_FORWARD_DEL))
        withTimeout(5_000) { while (c.view.selectionEnd != end) delay(20) }
        assertEquals(start to end, c.view.selectionStart to c.view.selectionEnd)
        assertEquals(source, c.sourceText())
    }

    @Test fun aSelectedImageIsTinted() = textFirstSession(source) { c ->
        val (start, end) = imageRange(c)
        ready(c, end)
        val view = c.view
        val l = view.layout
        val image = view.editableText.getSpans(start, end, TfImage::class.java).single()
        val x = view.totalPaddingLeft + (l.getPrimaryHorizontal(start) + image.drawSize().first - view.style.dp(4f)).toInt()
        val y = view.totalPaddingTop - view.scrollY + l.getLineBaseline(l.getLineForOffset(start)) - view.style.dp(4f).toInt()
        fun pixel(): Int {
            val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
            view.draw(Canvas(bitmap))
            return bitmap.getPixel(x, y)
        }
        val plain = pixel()
        c.select(start, end)
        withTimeout(5_000) { while (view.selectionStart != start || view.selectionEnd != end) delay(20) }
        delay(300)
        assertNotEquals("the selected image is not tinted", plain, pixel())
    }
}
