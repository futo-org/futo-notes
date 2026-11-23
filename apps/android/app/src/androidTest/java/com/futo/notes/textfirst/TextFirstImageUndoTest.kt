package com.futo.notes.textfirst

import android.graphics.Bitmap
import android.graphics.Color
import java.io.File
import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Undo of a deleted picture gives back the picture selected, as it was before the delete, not a range past it. A loaded
 * picture's bitmap, answered at once from the cache inside the update, used to switch off the view's applying flag, and
 * the update's own selection was then reported back with the old sequence and moved again.
 */
class TextFirstImageUndoTest {
    private val source = "before\n\n![a picture](picture.png)\n\nafter line"

    private fun picture(root: File) {
        val bitmap = Bitmap.createBitmap(400, 300, Bitmap.Config.ARGB_8888).apply { eraseColor(Color.BLUE) }
        File(root, "picture.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    @Test fun undoOfADeletedMissingPictureSelectsIt() = textFirstSession(source) { c -> check(c, loaded = false) }

    @Test fun undoOfADeletedPictureSelectsThePicture() = textFirstSession(source, ::picture) { c -> check(c, loaded = true) }

    private suspend fun check(c: TextFirstController, loaded: Boolean) {
        val view = c.view
        view.isFocusableInTouchMode = true
        view.requestFocus()
        withTimeout(5_000) { while (view.layout == null) delay(20) }
        val e = view.editableText
        withTimeout(5_000) { while (e.getSpans(0, e.length, TfImage::class.java).singleOrNull()?.let { if (loaded) it.bitmap != null else it.failed } != true) delay(50) }
        val image = e.getSpans(0, e.length, TfImage::class.java).single()
        val start = e.getSpanStart(image)
        val end = e.getSpanEnd(image)
        c.select(start, end)
        withTimeout(5_000) { while (view.selectionEnd != end) delay(20) }
        textFirstIme(c) { deleteSurroundingText(1, 0) }
        withTimeout(5_000) { while (c.sourceText() == source) delay(20) }
        c.undo()
        withTimeout(5_000) { while (c.sourceText() != source) delay(20) }
        delay(500)
        assertEquals("Undo selected past the picture", start to end, view.selectionStart to view.selectionEnd)
    }
}
