package com.futo.notes.textfirst

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Rect
import java.io.File
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * A selected picture's tint covers the picture exactly: the pixels selecting it changes are the picture's own. The
 * reported 15 px band under a selected picture was the TextView's own highlight, which reaches the line's 4 dp descent;
 * it is hidden while a picture is selected as one object (CodeSelectionPaint.refreshCodeHighlight).
 */
class TextFirstImageTintTest {
    private companion object { val PICTURE = Color.rgb(20, 200, 40) }

    private fun picture(root: File) {
        val bitmap = Bitmap.createBitmap(400, 300, Bitmap.Config.ARGB_8888).apply { eraseColor(PICTURE) }
        File(root, "picture.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    private suspend fun render(view: TextFirstEditText): Bitmap = withContext(Dispatchers.Main) {
        Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888).also { Canvas(it).apply { drawColor(Color.WHITE); view.draw(this) } }
    }

    private fun bounds(width: Int, height: Int, hit: (Int, Int) -> Boolean): Rect {
        val r = Rect(width, height, -1, -1)
        for (y in 0 until height) for (x in 0 until width) if (hit(x, y)) r.union(x, y)
        return Rect(r.left, r.top, r.right + 1, r.bottom + 1)
    }

    /** More than a rounded corner's anti-aliased edge changes. */
    private fun changed(before: Int, after: Int): Boolean =
        maxOf(Math.abs(Color.red(before) - Color.red(after)), Math.abs(Color.green(before) - Color.green(after)), Math.abs(Color.blue(before) - Color.blue(after))) > 24

    private suspend fun tintCoversThePicture(c: TextFirstController) {
        val view = c.view
        withContext(Dispatchers.Main) { view.isFocusableInTouchMode = true; view.requestFocus() }
        withTimeout(5_000) { while (view.layout == null) delay(20) }
        val e = view.editableText
        withTimeout(5_000) { while (e.getSpans(0, e.length, TfImage::class.java).singleOrNull()?.bitmap == null) delay(50) }
        val image = e.getSpans(0, e.length, TfImage::class.java).single()
        withContext(Dispatchers.Main) { view.isCursorVisible = false }
        c.select(0)
        c.sourceText()
        delay(300)
        val plain = render(view)
        val picture = bounds(plain.width, plain.height) { x, y -> plain.getPixel(x, y) == PICTURE }
        c.select(e.getSpanStart(image), e.getSpanEnd(image))
        withTimeout(5_000) { while (view.selectedObject == null) delay(20) }
        delay(300)
        val selected = render(view)
        val tint = bounds(plain.width, plain.height) { x, y -> changed(plain.getPixel(x, y), selected.getPixel(x, y)) }
        assertEquals("the tint's rect is the picture's", picture, tint)
    }

    @Test fun aPictureOnItsOwnLine() = textFirstSession("before\n\n![a picture](picture.png)\n\nafter", ::picture) { tintCoversThePicture(it) }

    @Test fun aPictureInsideALineOfText() = textFirstSession("before ![a picture](picture.png) after\n\nnext", ::picture) { tintCoversThePicture(it) }

    /**
     * A selection handle dragged into a picture sets the selection's end inside it again on every move, after the engine
     * has fitted it out (the drag that flickered: 31..38, then the engine's 7..38, then 31..38 again). No frame shows it
     * without the picture: the move into the picture the shown selection already takes whole leaves it as it is.
     */
    @Test fun aHandleMovedInsideASelectedPictureKeepsItWhole() = textFirstSession("before ![a picture](picture.png) after\n\nnext", ::picture) { c ->
        val view = c.view
        withContext(Dispatchers.Main) { view.isFocusableInTouchMode = true; view.requestFocus() }
        withTimeout(5_000) { while (view.layout == null) delay(20) }
        val e = view.editableText
        val image = e.getSpans(0, e.length, TfImage::class.java).single()
        val start = e.getSpanStart(image)
        val inside = e.getSpanEnd(image) - 1
        val end = e.indexOf(" after") + " after".length
        withContext(Dispatchers.Main) { android.text.Selection.setSelection(e, inside, end) }
        withTimeout(5_000) { while (view.selectionStart != start) delay(20) }
        val shownAfterMove = withContext(Dispatchers.Main) {
            android.text.Selection.setSelection(e, inside, end)
            view.selectionStart to view.selectionEnd
        }
        assertEquals("the move into the picture drew the selection without it", start to end, shownAfterMove)
    }
}
