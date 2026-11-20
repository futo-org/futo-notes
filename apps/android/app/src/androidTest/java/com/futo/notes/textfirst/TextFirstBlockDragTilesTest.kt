package com.futo.notes.textfirst

import android.graphics.Color
import android.graphics.RectF
import android.os.SystemClock
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/**
 * Mason (S23, batch 3): during a block drag, a fast autoscroll down and back left whole 256 px stretches of the note blank,
 * text and photos alike, from the tiles that had scrolled out of the drawn frame and back. Every tile the preview draws
 * shows what the note would draw there now.
 */
class TextFirstBlockDragTilesTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    private val lines = (1..160).joinToString("\n\n") { "line $it of the note" }

    @Test
    fun tilesThatLeftTheFrameAndCameBackStillDrawTheNote() = compose.openDragScreen(lines) {
        val from = at(offsetOf("line 6 of"))
        down(from); hold(600)
        assertTrue("lifted", lifted)
        val height = ui { view.height }
        val far = 3_000
        ui { view.scrollTo(0, far) }
        SystemClock.sleep(400)
        // A screen's worth further down: the stretch above stays recorded, out of the frame.
        ui { view.scrollTo(0, far + (height * 0.8f).toInt()) }
        SystemClock.sleep(600)
        ui { view.scrollTo(0, far) }
        SystemClock.sleep(400)
        val shot = screenshot()
        val top = viewInWindow().toFloat()
        val blank = (0 until (height * 0.8f).toInt() step SliceTiles.TILE.toInt()).filter { y ->
            ink(shot, RectF(40f, top + y, 700f, top + y + SliceTiles.TILE)).first == 0
        }
        up(from)
        assertTrue("stretches of the note drawn blank at view y $blank", blank.isEmpty())
    }

    /** A photo whose pixels land while the preview is drawing its tiles (the loader's own callback, replayed). */
    @Test
    fun aPhotoLandingDuringTheDragIsDrawn() = compose.openDragScreen("intro\n\n" + lines.take(400) + "\n\n![](p.png)\n\nend", mapOf("p.png" to png(600, 400, Color.MAGENTA))) {
        compose.waitUntil(5_000) { ui { view.text!!.getSpans(0, view.length(), TfImage::class.java).all { it.bitmap != null } } }
        val image = ui { view.text!!.getSpans(0, view.length(), TfImage::class.java).single() }
        val pixels = ui { image.bitmap!! }
        fun land(bitmap: android.graphics.Bitmap?) = ui {
            val e = view.editableText
            image.bitmap = bitmap
            e.setSpan(image, e.getSpanStart(image), e.getSpanEnd(image), TF_SPAN_FLAGS)
            view.requestLayout(); view.invalidate()
        }
        land(null)
        val from = at(offsetOf("line 6 of"))
        down(from); hold(600)
        assertTrue("lifted", lifted)
        ui { view.scrollTo(0, (view.boundaryY(BlockSlot(view.text.toString().indexOf("end"), false))!! - view.height * 0.6f).toInt().coerceAtLeast(0)) }
        SystemClock.sleep(400)
        land(pixels)
        SystemClock.sleep(400)
        val shot = screenshot()
        val window = ui { IntArray(2).also(view::getLocationOnScreen) }
        val (width, height) = ui { view.width to view.height }
        var magenta = 0
        for (y in window[1] until minOf(shot.height, window[1] + height) step 4) for (x in window[0] until minOf(shot.width, window[0] + width) step 4) {
            val p = shot.getPixel(x, y)
            if (Color.red(p) > 200 && Color.green(p) < 80 && Color.blue(p) > 200) magenta++
        }
        up(from)
        assertTrue("the photo drawn ($magenta photo pixels sampled)", magenta > 500)
    }

    /** Inline code's chip, drawn by the note (not the text's run background), in a window rect of [shot]: its filled grey, counted. */
    private fun BlockDragRig.chipPixels(shot: android.graphics.Bitmap, r: RectF): Int {
        val window = ui { IntArray(2).also(view.rootView::getLocationOnScreen) }
        // The chip's own fill: the text colour at 12% over the page (the card's lighter tint is not it).
        val fill = Color.red(ui { androidx.core.graphics.ColorUtils.compositeColors((view.style.textColor and 0x00ffffff) or 0x1F000000, Color.WHITE) })
        var count = 0
        for (y in (window[1] + r.top).toInt().coerceAtLeast(0) until (window[1] + r.bottom).toInt().coerceAtMost(shot.height))
            for (x in (window[0] + r.left).toInt().coerceAtLeast(0) until (window[0] + r.right).toInt().coerceAtMost(shot.width)) {
                fun grey(px: Int, py: Int): Boolean {
                    if (px >= shot.width || py >= shot.height) return false
                    val p = shot.getPixel(px, py)
                    return Math.abs(Color.red(p) - fill) <= 5 && Math.abs(Color.red(p) - Color.green(p)) < 7 && Math.abs(Color.green(p) - Color.blue(p)) < 7
                }
                // A filled patch, not a glyph's antialiased edge.
                if (grey(x, y) && grey(x + 3, y) && grey(x, y + 3) && grey(x + 3, y + 3)) count++
            }
        return count
    }

    private val codeNote = "intro line to lift\n\nA line with `inline code here` in it.\n\nnext\n\nmore\n\n" + (1..20).joinToString("\n\n") { "row $it" }

    /** Sol (batch 4): the chip is the note's drawing now; a lifted paragraph keeps it on its card. */
    @Test
    fun aLiftedParagraphKeepsItsInlineCodeChipOnTheCard() = compose.openDragScreen(codeNote) {
        val from = at(offsetOf("A line"))
        down(from); hold(600)
        assertTrue("lifted", lifted)
        SystemClock.sleep(400)
        val card = ui { view.blockLift.drag!!.cardInWindow() }
        val chip = chipPixels(screenshot(), RectF(card.left + 8, card.top + 8, card.right - 8, card.bottom - 8))
        up(from)
        assertTrue("the chip's grey on the card ($chip pixels)", chip > 300)
    }
}
