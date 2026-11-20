package com.futo.notes.textfirst

import android.graphics.PointF
import android.os.SystemClock
import android.view.MotionEvent
import android.view.ViewConfiguration
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/**
 * Who owns the note around a block drag (#450, the !716 review): a drop on its way takes the
 * note's input, a scroll that claimed a touch keeps it, focus ends a drag, only a finger lifts,
 * and a release drops only where the screen shows it.
 */
class TextFirstBlockDragOwnershipTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    private fun BlockDragRig.right() = ui { IntArray(2).also(view::getLocationOnScreen)[0] + view.width * 0.85f }

    /**
     * The editor takes longer than the 400 ms cap to make the move: the preview ends at the cap
     * and the old order shows again, but until the move lands the note takes no input, so a
     * checkbox tap and a hold made against the old order do nothing.
     */
    @Test
    fun whileASlowDropIsOnItsWayTheNoteTakesNoInput() = compose.openDragScreen("- [ ] one\n- [ ] two\n- [ ] six") {
        val from = at(offsetOf("one"))
        down(from); hold(600)
        val end = ui { BlockSlot(view.length() - 1, true) }
        val at = carryUntil(from, 8f, right()) { report?.gap == end }
        SystemClock.sleep(250)
        ui { view.engine!!.handler.post { SystemClock.sleep(2_000) } }
        val released = SystemClock.uptimeMillis()
        up(at)
        compose.waitUntil(1_000) { !lifted }
        assertTrue("the preview ended at the cap", SystemClock.uptimeMillis() - released < 700)
        // The old order shows: the first row's box is `one`'s, but the move will make it `two`'s.
        // The middle of the row's marker unit, where a tap ticks its box.
        val (boxX, row) = ui {
            val l = view.layout
            val line = l.getLineForOffset(offsetOf("one"))
            val start = l.getLineStart(line)
            (l.getPrimaryHorizontal(start) + l.getPrimaryHorizontal(start + 1)) / 2 to start
        }
        assertEquals("aimed at the box", row, ui {
            val l = view.layout
            val line = l.getLineForOffset(row)
            checkboxAt(view, view.style, view.totalPaddingLeft + boxX, view.totalPaddingTop - view.scrollY + (l.getLineTop(line) + l.getLineBottom(line)) / 2f)
        })
        val box = at(offsetOf("one"), x = boxX)
        down(box); up(box)
        val press = at(offsetOf("two"))
        down(press); hold(600)
        assertFalse("nothing lifts before the move lands", lifted)
        up(press)
        saved("- [ ] two\n- [ ] six\n- [ ] one")
        SystemClock.sleep(800)
        assertEquals("the tap changed nothing", "- [ ] two\n- [ ] six\n- [ ] one", file.readText())
        assertEquals(1, haptics.lifts)
    }

    /** With animations off (the drop line), a new width that cuts the view short of the lifted block: a release moves nothing. */
    @Test
    fun withAnimationsOffAWidthCutBeforeTheReleaseMovesNothing() {
        val rows = (1..1200).map { "row $it of a note long enough to be cut" }
        compose.openDragScreen(rows.joinToString("\n")) { withAnimationsOff {
            val target = offsetOf("row 1000 of")
            ui { view.scrollTo(0, view.layout.getLineTop(view.layout.getLineForOffset(target)) - 200) }
            SystemClock.sleep(300)
            val from = at(target)
            down(from); hold(600)
            assertTrue(lifted)
            val at = carryUntil(from, 8f) { ui { view.blockLift.drag?.slot } != null }
            ui { view.engine!!.handler.post { SystemClock.sleep(2_000) } }
            assertTrue("the view was cut", ui { view.boundForRelayout() })
            up(at)
            SystemClock.sleep(3_500)
            assertEquals(rows.joinToString("\n"), file.readText())
            assertEquals(0, haptics.lands)
        } }
    }

    /** The note scrolls under a still finger (here by the view itself, as a scroll restore after a resize does): the gap follows, without a tick. */
    @Test
    fun aScrollMadeByAnyoneDuringADragMovesTheGapUnderTheStillFinger() = compose.openDragScreen((1..80).joinToString("\n") { "row $it" }) {
        val from = at(offsetOf("row 10\n"))
        down(from); hold(600)
        val at = carryUntil(from, 8f, right()) { report?.gap != null }
        SystemClock.sleep(300)
        val gap = report?.gap
        val ticks = haptics.ticks
        ui { view.scrollBy(0, 400) }
        compose.waitUntil(2_000) { report?.gap != gap }
        assertNotEquals(gap, report?.gap)
        assertEquals("no tick from a scroll", ticks, haptics.ticks)
        up(at)
    }

    /** A wide table scrolled sideways just past the touch slop (inside the lift's tolerance), then held: the scroll keeps the touch. */
    @Test
    fun aTableScrolledSidewaysKeepsTheTouchThroughAHold() {
        val cols = 8
        val header = "| " + (1..cols).joinToString(" | ") { "column $it heading" } + " |"
        val rule = "|" + "---|".repeat(cols)
        val row = "| " + (1..cols).joinToString(" | ") { "x$it" } + " |"
        compose.openDragScreen("$header\n$rule\n$row\n\nend") {
            val from = at(offsetOf("x1"), x = 30f)
            val slop = ui { ViewConfiguration.get(view.context).scaledTouchSlop }
            val tolerance = ui { LiftPolicy.TOLERANCE_DP * view.style.density }
            assertTrue("the slop is inside the tolerance on this device", slop + 2 < tolerance)
            down(from)
            moveTo(from, PointF(from.x - slop - 2f, from.y), steps = 1)
            hold(700)
            assertFalse("the table's scroll keeps the touch", lifted)
            up(PointF(from.x - slop - 2f, from.y))
            SystemClock.sleep(300)
            assertEquals("$header\n$rule\n$row\n\nend", file.readText())
        }
    }

    /** The note gains focus during a drag (a hardware key, accessibility focus): the drag ends at once with nothing moved. */
    @Test
    fun focusArrivingDuringADragEndsIt() = compose.openDragScreen("alpha\nbravo\ncharlie") {
        val from = at(0)
        down(from); hold(600)
        val at = carryUntil(from, 8f, right()) { report?.gap != null }
        ui { view.requestFocus() }
        compose.waitUntil(1_000) { !lifted }
        up(at)
        SystemClock.sleep(700)
        assertEquals("alpha\nbravo\ncharlie", file.readText())
        assertEquals(0, haptics.lands)
    }

    /** A stylus resting on the note keeps the platform's long press: only a finger lifts a block. */
    @Test
    fun aStylusHoldLiftsNothing() = compose.openDragScreen("alpha\nbravo\ncharlie") {
        val p = at(offsetOf("bravo"))
        startDirect()
        dispatch(MotionEvent.ACTION_DOWN, listOf(p), tool = MotionEvent.TOOL_TYPE_STYLUS)
        hold(700)
        assertFalse(lifted)
        dispatch(MotionEvent.ACTION_UP, listOf(p), tool = MotionEvent.TOOL_TYPE_STYLUS)
    }
}
