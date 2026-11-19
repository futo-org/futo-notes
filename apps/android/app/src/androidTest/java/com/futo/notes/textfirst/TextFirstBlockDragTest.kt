package com.futo.notes.textfirst

import android.graphics.PointF
import android.os.SystemClock
import android.view.MotionEvent
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/**
 * The long-press block drag with real touches through the window (#444): with the keyboard
 * down a hold lifts the block under the finger, a card follows it and the drop lands at the
 * drop line drawn, as one move of the saved file; the exceptions keep the platform's long press.
 */
class TextFirstBlockDragTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun aHoldLiftsALineWithTheKeyboardDownAndDropsItAtTheDropLineDrawn() = compose.openDragScreen("alpha\nbravo\ncharlie\ndelta") {
        val from = at(0)
        val before = screenshot()
        down(from)
        hold(600)
        assertTrue("held still past 340 ms, the line lifts", lifted)
        assertEquals(1, haptics.lifts)
        // Below delta's middle the drop line is the note's end.
        val to = at(offsetOf("delta"), 0.9f)
        moveTo(from, to)
        hold(200)
        assertDrawn(before)
        assertEquals(ui { BlockSlot(view.length() - 1, true) }, ui { view.blockLift.drag?.slot })
        up(to)
        saved("bravo\ncharlie\ndelta\nalpha")
        assertEquals("one landing haptic", 1, haptics.lands)
        assertEquals("a tick for each new slot: above charlie, above delta, the end", 3, haptics.ticks)
        assertFalse("a lift starts no editing", ui { view.isFocused })
        assertFalse(lifted)
    }

    @Test
    fun aReleaseOverItsOwnPlaceMovesNothingSilently() = compose.openDragScreen("alpha\nbravo\ncharlie") {
        val from = at(offsetOf("bravo"))
        down(from); hold(600)
        assertTrue(lifted)
        val near = at(offsetOf("bravo"), 0.8f)
        moveTo(from, near, steps = 3); hold(150); up(near)
        SystemClock.sleep(700)
        assertEquals("alpha\nbravo\ncharlie", file.readText())
        assertEquals(0, haptics.lands)
        assertEquals(0, haptics.ticks)
    }

    @Test
    fun onABlankLineTheHoldOpensThePlatformsTextMenu() = compose.openDragScreen("alpha bravo\n\ncharlie") {
        val blank = at(offsetOf("charlie") - 1)
        down(blank); hold(900)
        assertFalse(lifted)
        up(blank)
        compose.waitUntil(3_000) { menus > 0 }
        assertEquals("alpha bravo\n\ncharlie", file.readText())
    }

    @Test
    fun withTheNoteFocusedAHoldSelectsTheWordAndLiftsNothing() = compose.openDragScreen("alpha bravo\n\ncharlie") {
        ui { view.requestFocus() }
        compose.waitUntil(3_000) { ui { view.isFocused } }
        SystemClock.sleep(1_000) // the keyboard rises
        val word = at(offsetOf("charlie"), x = 40f)
        down(word); hold(900)
        assertFalse(lifted)
        up(word)
        compose.waitUntil(3_000) { ui { view.selectionEnd > view.selectionStart } && menus > 0 }
        assertEquals("charlie", ui { view.text!!.substring(view.selectionStart, view.selectionEnd) })
    }

    @Test
    fun aPhotoSharingItsLineLiftsAloneAndATableLiftsWhole() =
        compose.openDragScreen("Nice!![](p.png)\nnext\n| a | b |\n|---|---|\n| 1 | 2 |\n\nend", mapOf("p.png" to png(300, 200))) {
            compose.waitUntil(5_000) { ui { view.text!!.getSpans(0, view.length(), TfImage::class.java).first().bitmap != null } }
            drag(photoCentre(0), at(offsetOf("next"), 0.9f))
            saved("Nice!\nnext\n![](p.png)\n| a | b |\n|---|---|\n| 1 | 2 |\n\nend")
            assertNotNull("the press is on the grid", ui { view.tableRowAt(at(offsetOf("1")).y - IntArray(2).also(view::getLocationOnScreen)[1]) })
            drag(at(offsetOf("1"), x = 30f), at(offsetOf("end"), 0.9f))
            saved("Nice!\nnext\n![](p.png)\n\nend\n| a | b |\n|---|---|\n| 1 | 2 |")
        }

    /** Above a short photo beside a tall one is the row, not the photo: the whole line lifts. */
    @Test
    fun aPressAboveAShortPhotoBesideATallOneLiftsTheLine() =
        compose.openDragScreen("![](tall.png)![](short.png)\nnext", mapOf("tall.png" to png(200, 400), "short.png" to png(200, 60))) {
            compose.waitUntil(5_000) { ui { view.text!!.getSpans(0, view.length(), TfImage::class.java).all { it.bitmap != null } } }
            val above = ui {
                val short = view.text!!.getSpans(0, view.length(), TfImage::class.java)[1]
                val r = checkNotNull(view.imageRect(short))
                val loc = IntArray(2).also(view::getLocationOnScreen)
                PointF(loc[0] + r.centerX(), loc[1] + r.top - view.scrollY - 100f)
            }
            drag(above, at(offsetOf("next"), 0.9f))
            saved("next\n![](tall.png)![](short.png)")
        }

    @Test
    fun theSystemCancellingTheLiftingFingerMovesNothing() = compose.openDragScreen("alpha\nbravo\ncharlie") {
        val from = at(0)
        val to = at(offsetOf("charlie"), 0.9f)
        val other = PointF(from.x + 200f, from.y)
        startDirect()
        dispatch(MotionEvent.ACTION_DOWN, listOf(from))
        hold(600)
        assertTrue(lifted)
        for (i in 1..6) dispatch(MotionEvent.ACTION_MOVE, listOf(PointF(from.x, from.y + (to.y - from.y) * i / 6)))
        assertTrue(ui { view.blockLift.drag?.slot } != null)
        // A palm lands; Android withdraws the first contact (POINTER_UP with FLAG_CANCELED).
        dispatch(MotionEvent.ACTION_POINTER_DOWN or (1 shl MotionEvent.ACTION_POINTER_INDEX_SHIFT), listOf(to, other))
        dispatch(MotionEvent.ACTION_POINTER_UP, listOf(to, other), flags = MotionEvent.FLAG_CANCELED)
        dispatch(MotionEvent.ACTION_UP, listOf(other))
        SystemClock.sleep(700)
        assertEquals("alpha\nbravo\ncharlie", file.readText())
        assertEquals(0, haptics.lands)
    }

    /** A finger that started scrolling the note (past the touch slop, inside the lift's tolerance) and then holds still lifts nothing. */
    @Test
    fun aScrollThatClaimedTheGestureStandsTheLiftDown() = compose.openDragScreen((1..60).joinToString("\n") { "row $it" }) {
        val from = at(offsetOf("row 3"))
        val slop = ui { android.view.ViewConfiguration.get(view.context).scaledTouchSlop }
        val tolerance = ui { LiftPolicy.TOLERANCE_DP * view.style.density }
        assertTrue("the slop is inside the tolerance on this device", slop + 1 < tolerance)
        down(from)
        moveTo(from, PointF(from.x, from.y - slop - 2f), steps = 1)
        hold(700)
        assertFalse(lifted)
        up(PointF(from.x, from.y - slop - 2f))
    }

    /** With the editor thread busy past the platform's long-press time, a hold released before the answer still gets the platform's long press. */
    @Test
    fun aBlankLineHoldKeepsThePlatformsLongPressWhileTheEngineIsBusy() = compose.openDragScreen("alpha\n\ncharlie") {
        val blank = at(offsetOf("charlie") - 1)
        ui { view.engine!!.handler.post { SystemClock.sleep(1_500) } }
        down(blank); hold(900); up(blank)
        compose.waitUntil(4_000) { menus > 0 }
        assertFalse(lifted)
        assertEquals("alpha\n\ncharlie", file.readText())
    }

    private fun BlockDragRig.photoCentre(index: Int): PointF = ui {
        val image = view.text!!.getSpans(0, view.length(), TfImage::class.java)[index]
        val r = checkNotNull(view.imageRect(image))
        val loc = IntArray(2).also(view::getLocationOnScreen)
        PointF(loc[0] + r.centerX(), loc[1] + r.centerY() - view.scrollY)
    }
}
