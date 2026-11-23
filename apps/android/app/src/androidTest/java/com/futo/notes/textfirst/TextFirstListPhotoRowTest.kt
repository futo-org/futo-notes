package com.futo.notes.textfirst

import android.graphics.Bitmap
import android.graphics.Color
import java.io.File
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Test

/** Review (Sol): an image-only task is a photo row, as a photo on a line of its own is: the marker unit before it aside. */
class TextFirstListPhotoRowTest {
    private fun photo(root: File) {
        val bitmap = Bitmap.createBitmap(800, 600, Bitmap.Config.ARGB_8888).apply { eraseColor(Color.MAGENTA) }
        File(root, "p.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    /** The room above the loaded photo in its row, and the row's height. */
    private suspend fun photoRow(c: TextFirstController): Pair<Int, Int> {
        withTimeout(5_000) {
            while (withContext(Dispatchers.Main) { c.view.layout == null || c.view.editableText.getSpans(0, c.view.length(), TfImage::class.java).singleOrNull()?.bitmap == null }) delay(20)
        }
        delay(300)
        return withContext(Dispatchers.Main) {
            val e = c.view.editableText
            val l = c.view.layout
            val image = e.getSpans(0, e.length, TfImage::class.java).single()
            val line = l.getLineForOffset(e.getSpanStart(image))
            val drawn = android.graphics.RectF().also { imageDrawnRect(l, e, image, it) }
            (drawn.top - l.getLineTop(line)).toInt() to l.getLineBottom(line) - l.getLineTop(line)
        }
    }

    @Test fun anImageOnlyTasksPhotoSitsInItsRowAsAPhotoAloneDoes() {
        var alone = 0 to 0
        textFirstSession("![](p.png)\n\nend", ::photo) { c -> alone = photoRow(c) }
        textFirstSession("- [ ] ![](p.png)\n\nend", ::photo) { c ->
            assertEquals("the room above the photo, and the row", alone, photoRow(c))
        }
    }
}
