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

    /** The code card's colour as drawn before any lift: right of the text on the row holding [code]. */
    private fun BlockDragRig.cardColour(shot: Bitmap, code: Int): Int {
        val (x, y) = ui {
            val l = view.layout
            val line = l.getLineForOffset(code)
            val at = IntArray(2).also(view::getLocationOnScreen)
            (at[0] + view.width - view.totalPaddingRight - 20) to (at[1] + view.totalPaddingTop - view.scrollY + (l.getLineTop(line) + l.getLineBottom(line)) / 2)
        }
        return shot.getPixel(x, y).also { check(it != Color.WHITE) { "no card drawn at ($x, $y)" } }
    }

    /** Pixels of [card]'s colour in [area] (window coordinates), every second pixel. */
    private fun BlockDragRig.codeCardPixels(shot: Bitmap, area: RectF, card: Int): Int {
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

    /** The reflow preview draws the code card where it is, as the view drew it (Sol review of the merge, 11). */
    @Test
    fun theReflowPreviewDrawsTheCodeCard() =
        compose.openDragScreen("```js name:demo.js\nconst x = 1\n```\n\n" + (1..14).joinToString("\n") { "line $it" }) {
            val before = screenshot()
            val card = cardColour(before, offsetOf("const"))
            val drawn = codeCardPixels(before, noteInWindow(), card)
            val from = at(offsetOf("line 8"))
            down(from); hold(600)
            assertTrue("lifted", lifted)
            val at = carryUntil(from, 8f, ui { IntArray(2).also(view::getLocationOnScreen)[0] + view.width * 0.85f }) { (report?.gap?.offset ?: 0) > offsetOf("line 9") }
            SystemClock.sleep(Slide.SLIDE_MS + 120)
            assertEquals("no autoscroll", 0, ui { view.scrollY })
            val moved = codeCardPixels(screenshot(), noteInWindow(), card)
            assertTrue("the card stays drawn ($moved of $drawn px)", moved > drawn / 2)
            up(at)
            compose.waitUntil(5_000) { !file.readText().contains("line 7\nline 8") }
            compose.waitUntil(2_000) { !lifted }
        }

    /** Tiles recorded mid-drag (autoscroll brings new ones) keep the header's targets as the view drew them (Sol review of the merge, 5). */
    @Test
    fun theHeadersTargetsSurviveTilesRecordedMidDrag() =
        compose.openDragScreen("```js name:demo.js\nconst x = 1\n```\n\n" + (1..24).joinToString("\n") { "line $it" }) {
            val code = offsetOf("const")
            val chip = ui { RectF(checkNotNull(view.codeChrome.areaOf(code, CodeBlockAction.LANGUAGE_LABEL))) }
            val from = at(offsetOf("line 20"))
            down(from); hold(600)
            assertTrue("lifted", lifted)
            val at = carryUntil(from, 8f, ui { IntArray(2).also(view::getLocationOnScreen)[0] + view.width * 0.85f }) { (report?.gap?.offset ?: 0) > offsetOf("line 21") }
            SystemClock.sleep(Slide.SLIDE_MS + 120)
            assertEquals("the chip's tap target is the one the view drew", chip, ui { view.codeChrome.areaOf(code, CodeBlockAction.LANGUAGE_LABEL) })
            up(at)
            compose.waitUntil(5_000) { !file.readText().contains("line 19\nline 20") }
            compose.waitUntil(2_000) { !lifted }
        }

    @Test
    fun aLiftedCodeBlockCarriesItsCard() = compose.openDragScreen(note) {
        val card = cardColour(screenshot(), offsetOf("const"))
        val from = at(offsetOf("const"))
        down(from); hold(600)
        assertTrue("lifted", lifted)
        moveTo(from, android.graphics.PointF(from.x, from.y + 40f), steps = 4)
        SystemClock.sleep(Slide.SLIDE_MS + 120)
        val area = ui { view.blockLift.drag!!.cardInWindow() }
        val drawn = codeCardPixels(screenshot(), area, card)
        // Every second pixel each way was looked at: most of the card is the code card's colour.
        val looked = (area.width() / 2) * (area.height() / 2)
        assertTrue("the lifted card at $area shows the code card ($drawn of $looked px)", drawn > looked * 0.4f)
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
