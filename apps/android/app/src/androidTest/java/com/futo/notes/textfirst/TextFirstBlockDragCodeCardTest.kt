package com.futo.notes.textfirst

import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.RectF
import android.os.SystemClock
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/** A block drag over a code block (Sol review of the merge, 5, 8, 11): the card stays drawn, and its header keeps its taps. */
class TextFirstBlockDragCodeCardTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    private val note = "before\n\n```js name:demo.js\nconst x = 1\n```\n\nafter"

    /** Pixels of the code card's own colour in [area] (window coordinates), every second pixel. */
    private fun BlockDragRig.codeCardPixels(shot: Bitmap, area: RectF): Int {
        val card = ui { view.style.codeBackground }
        val window = ui { IntArray(2).also(view.rootView::getLocationOnScreen) }
        var count = 0
        for (x in (window[0] + area.left).toInt().coerceIn(0, shot.width) until (window[0] + area.right).toInt().coerceIn(0, shot.width) step 2) {
            for (y in (window[1] + area.top).toInt().coerceIn(0, shot.height) until (window[1] + area.bottom).toInt().coerceIn(0, shot.height) step 2) {
                val p = shot.getPixel(x, y)
                if (maxOf(Math.abs(Color.red(p) - Color.red(card)), Math.abs(Color.green(p) - Color.green(card)), Math.abs(Color.blue(p) - Color.blue(card))) <= 4) count++
            }
        }
        return count
    }

    private fun BlockDragRig.noteInWindow(): RectF = ui {
        val at = IntArray(2).also(view::getLocationInWindow)
        RectF(at[0].toFloat(), at[1].toFloat(), (at[0] + view.width).toFloat(), (at[1] + view.height).toFloat())
    }

    /** Codex's case: prose reordered on a tile the card is not on; the preview re-records that tile last. */
    @Test
    fun aCodeBlockKeepsItsTapsWhileProseFarBelowItIsCarried() =
        compose.openDragScreen("```js name:demo.js\nconst x = 1\n```\n\n" + (1..24).joinToString("\n") { "line $it" }) {
            val code = offsetOf("const")
            val chip = ui { RectF(checkNotNull(view.codeChrome.areaOf(code, CodeBlockAction.LANGUAGE_LABEL))) }
            val drawn = codeCardPixels(screenshot(), noteInWindow())
            val from = at(offsetOf("line 20"))
            down(from); hold(600)
            assertTrue("lifted", lifted)
            val at = carryUntil(from, 8f, ui { IntArray(2).also(view::getLocationOnScreen)[0] + view.width * 0.85f }) { (report?.gap?.offset ?: 0) > offsetOf("line 21") }
            SystemClock.sleep(Slide.SLIDE_MS + 120)
            assertTrue("the card stays drawn", codeCardPixels(screenshot(), noteInWindow()) > drawn / 2)
            assertEquals("the chip's tap target is the one the view drew", chip, ui { view.codeChrome.areaOf(code, CodeBlockAction.LANGUAGE_LABEL) })
            up(at)
            compose.waitUntil(5_000) { !file.readText().contains("line 19\nline 20") }
            compose.waitUntil(2_000) { !lifted }
        }

    @Test
    fun aLiftedCodeBlockCarriesItsCard() = compose.openDragScreen(note) {
        val from = at(offsetOf("const"))
        down(from); hold(600)
        assertTrue("lifted", lifted)
        moveTo(from, android.graphics.PointF(from.x, from.y + 40f), steps = 4)
        SystemClock.sleep(Slide.SLIDE_MS + 120)
        val card = ui { view.blockLift.drag!!.cardInWindow() }
        val drawn = codeCardPixels(screenshot(), card)
        assertTrue("the lifted card at $card shows the code card ($drawn px)", drawn > 100)
        up(android.graphics.PointF(from.x, from.y + 40f))
        compose.waitUntil(2_000) { !lifted }
    }

    /** Sol review of the merge (9): a copied block moved away leaves no checkmark on the block that takes its place. */
    @Test
    fun aMovedCopiedBlockLeavesNoCheckmarkBehind() = compose.openDragScreen("```js\nx\n```\n```py\ny\n```\nend") {
        val code = offsetOf("x")
        val copy = ui { RectF(checkNotNull(view.codeChrome.areaOf(code, CodeBlockAction.COPY_CODE))) }
        val at = ui { IntArray(2).also(view::getLocationOnScreen) }
        val glyph = android.graphics.PointF(at[0] + view.totalPaddingLeft + copy.centerX(), at[1] + view.totalPaddingTop - ui { view.scrollY } + copy.centerY())
        down(glyph); up(glyph)
        compose.waitUntil(2_000) { ui { view.codeTouch.copiedBlock } == code }
        ui { val e = view.engine!!; e.handler.post { e.moveBlock(code, BlockSlot(view.length() - 1, true)) } }
        compose.waitUntil(3_000) { file.readText().startsWith("```py") }
        assertEquals("the copy glyph's checkmark after the move", -1, ui { view.codeTouch.copiedBlock })
    }
}
