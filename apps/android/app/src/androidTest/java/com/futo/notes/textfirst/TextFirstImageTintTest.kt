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
import org.junit.Assert.assertTrue
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
        Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888).also { Canvas(it).apply { drawColor(Color.WHITE); translate(-view.scrollX.toFloat(), -view.scrollY.toFloat()); view.draw(this) } }
    }

    private fun bounds(width: Int, height: Int, hit: (Int, Int) -> Boolean): Rect {
        val r = Rect(width, height, -1, -1)
        for (y in 0 until height) for (x in 0 until width) if (hit(x, y)) r.union(x, y)
        return Rect(r.left, r.top, r.right + 1, r.bottom + 1)
    }

    /** More than a rounded corner's anti-aliased edge changes. */
    private fun changed(before: Int, after: Int): Boolean =
        maxOf(Math.abs(Color.red(before) - Color.red(after)), Math.abs(Color.green(before) - Color.green(after)), Math.abs(Color.blue(before) - Color.blue(after))) > 24

    /** [slack]: a photo on a fractional x (a right-to-left row) blends its edge column, which the exact colour misses. */
    private suspend fun tintCoversThePicture(c: TextFirstController, slack: Int = 0) {
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
        val edges = listOf(picture.left - tint.left, picture.top - tint.top, picture.right - tint.right, picture.bottom - tint.bottom)
        assertTrue("the tint's rect $tint is the picture's $picture", edges.all { Math.abs(it) <= slack })
    }

    /**
     * Mason (S23, batch 3): scrolled half under the title bar, a selected picture showed about 48 px untinted there (the
     * top padding the note's text scrolls into). The tint covers what is drawn of the picture there too.
     */
    @Test fun aPictureScrolledUnderTheTopEdgeIsTintedThere() = textFirstSession((1..30).joinToString("") { "line $it\n\n" } + "![a picture](picture.png)\n\n" + (1..30).joinToString("") { "after $it\n\n" }, ::picture) { c ->
        val view = c.view
        withContext(Dispatchers.Main) { view.isFocusableInTouchMode = true; view.requestFocus() }
        withTimeout(5_000) { while (view.layout == null) delay(20) }
        val e = view.editableText
        withTimeout(5_000) { while (e.getSpans(0, e.length, TfImage::class.java).singleOrNull()?.bitmap == null) delay(50) }
        val image = e.getSpans(0, e.length, TfImage::class.java).single()
        withContext(Dispatchers.Main) { view.isCursorVisible = false }
        // The picture's middle row at the top padding's bottom edge: its upper half drawn in the padding band.
        val scroll = withContext(Dispatchers.Main) { val l = view.layout; val line = l.getLineForOffset(e.getSpanStart(image)); (l.getLineTop(line) + l.getLineBottom(line)) / 2 }
        suspend fun shot(): Bitmap { withContext(Dispatchers.Main) { view.scrollTo(0, scroll) }; delay(300); return render(view) }
        c.select(0)
        val plain = shot()
        val picture = bounds(plain.width, plain.height) { x, y -> plain.getPixel(x, y) == PICTURE }
        c.select(e.getSpanStart(image), e.getSpanEnd(image))
        withTimeout(5_000) { while (view.selectedObject == null) delay(20) }
        val selected = shot()
        assertTrue("the picture is drawn in the top padding (from ${picture.top})", picture.top < view.totalPaddingTop / 2)
        val tint = bounds(plain.width, plain.height) { x, y -> changed(plain.getPixel(x, y), selected.getPixel(x, y)) }
        assertEquals("the tint's rect is the picture's", picture, tint)
    }

    /** Batch 4 (C): a photo alone on its row has as much room above it as below it, the note's last row included. */
    @Test fun aPictureAloneOnItsRowHasEqualRoomAboveAndBelow() {
        for (note in listOf("before\n\n![a picture](picture.png)\n\nafter", "before\n\n![a picture](picture.png)")) textFirstSession(note, ::picture) { c ->
            val view = c.view
            withTimeout(5_000) { while (view.layout == null || view.editableText.getSpans(0, view.length(), TfImage::class.java).single().bitmap == null) delay(50) }
            delay(300)
            val l = view.layout
            val e = view.editableText
            val image = e.getSpans(0, e.length, TfImage::class.java).single()
            val rect = android.graphics.RectF().also { imageDrawnRect(l, e, image, it) }
            val line = l.getLineForOffset(e.getSpanStart(image))
            val above = rect.top - l.getLineTop(line)
            val below = l.getLineBottom(line) - rect.bottom
            assertEquals("room above and below the photo in ${note.replace("\n", "|")}", above, below, 1f)
        }
    }

    /** Batch 4 (F): in a right-to-left row the tint was drawn rightward from the photo's right edge. */
    @Test fun aPictureInARightToLeftLine() = textFirstSession("\u05e9\u05dc\u05d5\u05dd ![a picture](picture.png) \u05e2\u05d5\u05dc\u05dd\n\nnext", ::picture) { tintCoversThePicture(it, slack = 1) }

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

    /** Verifier: the end handle dragged down through a picture the selection holds whole, from past its end. */
    @Test fun anEndHandleMovedInsideAPictureTheSelectionHoldsKeepsIt() = textFirstSession("own line below\n\n![a picture](picture.png)\n\nmiddle text", ::picture) { c ->
        val view = c.view
        withContext(Dispatchers.Main) { view.isFocusableInTouchMode = true; view.requestFocus() }
        withTimeout(5_000) { while (view.layout == null) delay(20) }
        val e = view.editableText
        val image = e.getSpans(0, e.length, TfImage::class.java).single()
        val start = e.indexOf("below")
        val pastPicture = e.getSpanEnd(image) + 1
        withContext(Dispatchers.Main) { android.text.Selection.setSelection(e, start, pastPicture) }
        withTimeout(5_000) { while (view.selectionEnd != pastPicture) delay(20) }
        delay(200)
        val shownAfterMove = withContext(Dispatchers.Main) {
            android.text.Selection.setSelection(e, start, e.getSpanEnd(image) - 3)
            view.selectionStart to view.selectionEnd
        }
        assertEquals("the move into the picture drew the selection without it", start to pastPicture, shownAfterMove)
    }
}

