package com.futo.notes.textfirst

import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.Rect
import android.graphics.drawable.DrawableWrapper
import java.io.File
import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Test

/** Mason (from the desktop editor): a caret beside a photo taller than its text is as tall as the photo, as on desktop. */
class TextFirstPhotoCaretTest {
    private val note = "before ![t](tall.png) after\n\nx ![s](short.png) y\n\nz ![m](missing.png) w\n"

    private fun photos(root: File) {
        for ((name, size) in listOf("tall.png" to (400 to 300), "short.png" to (60 to 20))) {
            val bitmap = Bitmap.createBitmap(size.first, size.second, Bitmap.Config.ARGB_8888).apply { eraseColor(Color.MAGENTA) }
            File(root, name).outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        }
    }

    /** The caret's drawn bar with the caret at [offset], layout coordinates. */
    private suspend fun barAt(c: TextFirstController, offset: Int): Rect {
        c.select(offset)
        withTimeout(5_000) { while (c.view.selectionStart != offset) delay(20) }
        delay(300)
        val caret = (c.view.textCursorDrawable as DrawableWrapper).drawable!!
        val padding = Rect().also { caret.getPadding(it) }
        return Rect(caret.bounds.left + padding.left, caret.bounds.top + padding.top, caret.bounds.right - padding.right, caret.bounds.bottom - padding.bottom)
    }

    private suspend fun caretAt(c: TextFirstController, offset: Int): IntRange = barAt(c, offset).let { it.top..it.bottom }

    private fun image(c: TextFirstController, name: String): TfImage =
        c.view.editableText.let { e -> e.getSpans(0, e.length, TfImage::class.java).single { it.destination == name } }

    @Test fun beforeAndAfterATallPhotoTheCaretIsThePhotosHeight() = textFirstSession(note, ::photos) { c ->
        val view = c.view
        view.isFocusableInTouchMode = true; view.requestFocusFromTouch()
        withTimeout(5_000) { while (view.layout == null || image(c, "tall.png").bitmap == null || image(c, "short.png").bitmap == null) delay(50) }
        delay(300)
        val tall = image(c, "tall.png")
        val e = view.editableText
        val baseline = view.layout.getLineBaseline(view.layout.getLineForOffset(e.getSpanStart(tall)))
        val photo = baseline - tall.drawSize().second..baseline
        assertEquals("the caret before the tall photo", photo, caretAt(c, e.getSpanStart(tall)))
        assertEquals("the caret after the tall photo", photo, caretAt(c, e.getSpanEnd(tall)))
        // The platform draws the caret under the text: it stands just outside the photo, never on it.
        val left = view.layout.getPrimaryHorizontal(e.getSpanStart(tall)).toInt()
        assertEquals("the caret before the photo ends at its left edge", left.toFloat(), barAt(c, e.getSpanStart(tall)).right.toFloat(), 1f)
        assertEquals("the caret after the photo starts at its right edge", (left + tall.drawSize().first).toFloat(), barAt(c, e.getSpanEnd(tall)).left.toFloat(), 1f)
        val text = caretAt(c, e.indexOf("before") + 2)
        val textHeight = text.last - text.first
        for (name in listOf("short.png", "missing.png")) {
            val small = image(c, name)
            for (offset in listOf(e.getSpanStart(small), e.getSpanEnd(small))) {
                val caret = caretAt(c, offset)
                assertEquals("the caret beside $name at $offset is one text line tall", textHeight, caret.last - caret.first)
            }
        }
    }
}
