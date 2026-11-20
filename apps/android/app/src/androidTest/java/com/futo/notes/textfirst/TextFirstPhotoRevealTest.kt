package com.futo.notes.textfirst

import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.RectF
import java.io.File
import kotlinx.coroutines.delay
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Mason (batch 5, MR run-up): a caret put beside a photo taller than the space shows the photo from its top; typing beside
 * it shows where the typed text lands, at the row's baseline end, and the next character keeps that scroll.
 */
class TextFirstPhotoRevealTest {
    private val prose = (1..30).joinToString("\n\n") { "line $it of prose" }

    private fun photos(root: File) {
        for ((name, size) in listOf("tall.png" to (300 to 3000))) {
            val bitmap = Bitmap.createBitmap(size.first, size.second, Bitmap.Config.ARGB_8888).apply { eraseColor(Color.MAGENTA) }
            File(root, name).outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        }
    }

    private suspend fun await(what: String, done: () -> Boolean) {
        val until = System.currentTimeMillis() + 5_000
        while (!done()) {
            check(System.currentTimeMillis() < until) { "no $what in 5 s" }
            delay(20)
        }
    }

    /** The photo [name] loaded, in a note [space] px tall (the keyboard up); its span. */
    private suspend fun photoIn(c: TextFirstController, name: String, space: (photoHeight: Int) -> Int): TfImage {
        val view = c.view
        view.isFocusableInTouchMode = true
        view.requestFocus()
        await("$name loaded") { view.layout != null && view.editableText.getSpans(0, view.length(), TfImage::class.java).any { it.destination == name && it.bitmap != null } }
        val photo = view.editableText.getSpans(0, view.length(), TfImage::class.java).single { it.destination == name }
        val height = space(drawn(c, photo).height().toInt()) + view.totalPaddingTop + view.totalPaddingBottom
        val params = view.layoutParams
        params.height = height
        view.layoutParams = params
        await("the note's resize") { view.height == height }
        delay(300)
        return photo
    }

    private fun drawn(c: TextFirstController, photo: TfImage): RectF =
        RectF().also { imageDrawnRect(c.view.layout, c.view.editableText, photo, it) }

    private suspend fun caretAt(c: TextFirstController, offset: Int) {
        c.select(offset)
        await("the caret at $offset") { c.view.selectionStart == offset }
        delay(400)
    }

    @Test fun typingBesideAPhotoTallerThanTheViewShowsTheTypedText() = textFirstSession("$prose\n\n![t](tall.png)\n\nend", ::photos) { c ->
        val photo = photoIn(c, "tall.png") { photo -> photo / 2 }
        val view = c.view
        val after = view.editableText.getSpanEnd(photo)
        caretAt(c, after)
        assertTrue("a caret put beside the photo shows it from its top", drawn(c, photo).top >= view.scrollY)
        textFirstIme(c) { commitText("x", 1) }
        await("the x typed") { view.selectionStart == after + 1 }
        delay(400)
        val baseline = view.layout.getLineBaseline(view.layout.getLineForOffset(after + 1))
        val visible = view.scrollY..(view.scrollY + view.height - view.totalPaddingTop - view.totalPaddingBottom)
        assertTrue("the typed text's line ($baseline) is on screen ($visible)", baseline - view.lineHeight >= visible.first && baseline <= visible.last)
        val scroll = view.scrollY
        textFirstIme(c) { commitText("y", 1) }
        await("the y typed") { view.selectionStart == after + 2 }
        delay(400)
        assertEquals("the next character keeps the scroll", scroll, view.scrollY)
    }
}
