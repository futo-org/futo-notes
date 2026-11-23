package com.futo.notes.textfirst

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Mason (job 11 C): the highlight in a block's name and language fields sat too far down, and the text sat low in its
 * chip. The selected text's highlight reaches as far above its ink as below it, and the ink is centred in the chip.
 */
class TextFirstCodeHeaderCentringTest {
    // Ascenders and descenders, no dots: the field centres the font's capitals-to-descenders span, not each word's ink.
    private val note = "intro\n\n```graphql name:short.go\nconst a = 1\n```\n\nafter"

    /** The first and last row (exclusive) of [bitmap] where any pixel in a column passes [matches]. */
    private fun rows(bitmap: Bitmap, matches: (Int) -> Boolean): IntRange {
        val hits = (0 until bitmap.height).filter { y -> (0 until bitmap.width).any { x -> matches(bitmap.getPixel(x, y)) } }
        return hits.first()..hits.last()
    }

    private fun check(action: CodeBlockAction) = textFirstSession(note) { c ->
        val view = c.view
        val start = view.editableText.indexOf("const a")
        withTimeout(5_000) { while (view.codeChrome.areaOf(start, action) == null) delay(20) }
        val area = view.codeChrome.areaOf(start, action)!!
        holdNoteAt(view, view.totalPaddingLeft + area.centerX(), view.totalPaddingTop - view.scrollY + area.centerY())
        val field = openHeaderField(view)
        withTimeout(5_000) { while (field.height <= 1 || field.selectionEnd - field.selectionStart != field.length()) delay(20) }
        field.isCursorVisible = false
        delay(300)
        val bitmap = Bitmap.createBitmap(field.width, field.height, Bitmap.Config.ARGB_8888).also { Canvas(it).apply { drawColor(Color.WHITE); field.draw(this) } }
        val highlight = rows(bitmap) { maxOf(Color.red(it), Color.green(it), Color.blue(it)) - minOf(Color.red(it), Color.green(it), Color.blue(it)) > 40 }
        val ink = rows(bitmap) { maxOf(Color.red(it), Color.green(it), Color.blue(it)) < 110 }
        val chip = rows(bitmap) { it != Color.WHITE }
        val above = ink.first - highlight.first
        val below = highlight.last - ink.last
        // Antialiasing moves a glyph's detected edge by a pixel.
        val tolerance = 2
        assertTrue("the highlight reaches $above px above the text and $below px below it", Math.abs(above - below) <= tolerance)
        val inChipAbove = ink.first - chip.first
        val inChipBelow = chip.last - ink.last
        assertTrue("the text sits $inChipAbove px from the chip's top and $inChipBelow px from its bottom", Math.abs(inChipAbove - inChipBelow) <= tolerance)
    }

    @Test fun theNameFieldsHighlightAndTextAreCentred() = check(CodeBlockAction.NAME_FIELD)

    @Test fun theLanguageFieldsHighlightAndTextAreCentred() = check(CodeBlockAction.LANGUAGE_LABEL)
}
