package com.futo.notes.textfirst

import android.graphics.PointF
import android.os.SystemClock
import android.util.Log
import android.view.ViewGroup
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/** The block drag at the edges (#444): autoscroll, changes and interruptions mid-drag, long and streaming notes. */
class TextFirstBlockDragEdgeTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    private val rows = (1..80).map { "row $it" }

    private fun BlockDragRig.bottomEdge(): PointF = ui {
        val loc = IntArray(2).also(view::getLocationOnScreen)
        PointF(loc[0] + 100f, loc[1] + view.height - 4f)
    }

    @Test
    fun withAnimationsOffHeldStillAtTheBottomEdgeTheNoteScrollsWithoutTicksAndTheDropLandsAtTheLineDrawn() = compose.openDragScreen(rows.joinToString("\n")) { withAnimationsOff {
        val from = at(0)
        down(from); hold(600)
        assertTrue(lifted)
        val edge = bottomEdge()
        moveTo(from, edge)
        val ticks = haptics.ticks
        val scrolled = ui { view.scrollY }
        hold(1_200)
        assertTrue("the note scrolled under the still finger", ui { view.scrollY } > scrolled + 600)
        assertEquals("no ticks from the scroll alone", ticks, haptics.ticks)
        // Back out of the zone the scroll stops; the drop lands at the line drawn.
        val inside = PointF(edge.x, edge.y - 300f)
        moveTo(edge, inside, steps = 4); hold(300)
        assertDrawn(null)
        val below = ui { val slot = view.blockLift.drag!!.slot!!; view.text!!.substring(slot.offset).substringBefore('\n') }
        up(inside)
        val moved = rows.drop(1).toMutableList().apply { add(indexOf(below), rows[0]) }
        saved(moved.joinToString("\n"))
        assertTrue("dropped far below the first screen", moved.indexOf("row 1") > 20)
    } }

    @Test
    fun atTheEndOfTheNoteTheAutoscrollStopsAskingForFrames() = compose.openDragScreen("alpha\nbravo\ncharlie") {
        val from = at(0)
        down(from); hold(600)
        moveTo(from, bottomEdge())
        hold(300)
        assertTrue(lifted)
        assertFalse("nothing to scroll: no frames requested", ui { view.blockLift.autoscrollRunning })
        up(bottomEdge())
    }

    /** Carried away and back while the note autoscrolled, a block released over its own place moves nothing and the preview ends. */
    @Test
    fun aReleaseOverItsOwnPlaceAfterAutoscrollMovesNothing() = compose.openDragScreen(rows.joinToString("\n")) {
        val from = at(offsetOf("row 22"))
        down(from); hold(600)
        assertTrue(lifted)
        val edge = bottomEdge()
        moveTo(from, edge, steps = 3); hold(100)
        assertTrue("the gap left home", report?.gap != null)
        // Out of the zone (the scroll stops), then back over the block's own place, which has moved up with the note.
        val middle = PointF(edge.x, edge.y - 500f)
        moveTo(edge, middle, steps = 3); hold(200)
        assertTrue("the note scrolled", ui { view.scrollY } > 100)
        val home = at(offsetOf("row 22"), 0.45f)
        moveTo(middle, home, steps = 6); hold(200)
        assertNull("over its own place the gap is home", report!!.gap)
        up(home)
        compose.waitUntil(1_000) { !lifted }
        assertEquals(rows.joinToString("\n"), file.readText())
        assertEquals(0, haptics.lands)
    }

    @Test
    fun aChangeToTheNoteMidDragCancelsItWithNothingMoved() = compose.openDragScreen("alpha\nbravo\ncharlie") {
        val from = at(0)
        down(from); hold(600)
        assertTrue(lifted)
        val to = at(offsetOf("charlie"), 0.9f)
        moveTo(from, to)
        assertTrue("the reflow preview is open", report!!.opened)
        // An edit lands from elsewhere (as a sync would), while the finger is still down: the preview goes at once.
        ui { view.engine!!.hostSelect(0, 0) }
        ui { view.engine!!.paste("Z") }
        compose.waitUntil(3_000) { !lifted }
        hold(100); up(to)
        saved("Zalpha\nbravo\ncharlie")
        assertEquals(0, haptics.lands)
    }

    /** A move made elsewhere (puppet's MoveBlock) while a finger holds another block ends that drag at once. */
    @Test
    fun anotherBlocksMoveMidDragCancelsIt() = compose.openDragScreen("alpha\nbravo\ncharlie") {
        val from = at(offsetOf("charlie"))
        down(from); hold(600)
        assertTrue(lifted)
        ui { val e = view.engine!!; e.handler.post { e.moveBlock(0, BlockSlot(12, false)) } }
        compose.waitUntil(3_000) { !lifted }
        hold(100); up(from)
        saved("bravo\nalpha\ncharlie")
    }

    @Test
    fun aWidthChangeMidDragMeasuresTheCardAgain() = compose.openDragScreen("alpha is a line long enough to wrap when the note gets narrow enough\nbravo") {
        val from = at(0)
        down(from); hold(600)
        assertTrue(lifted)
        val (tall, cardBefore) = ui { view.blockLift.drag!!.let { it.sourceInWindow()!!.height() to it.cardInWindow().height() } }
        // The text column narrows (as a new width would make it): the block wraps to more rows.
        ui { view.setPadding(view.paddingLeft, view.paddingTop, view.width / 2, view.paddingBottom) }
        // It wraps to at least one row more (not "half as many again": on a wide screen the block starts on two rows and halving the column gives three).
        val row = ui { view.lineHeight }
        compose.waitUntil(3_000) { ui { view.blockLift.drag!!.sourceInWindow()!!.height() } > tall + row / 2f }
        val (card, source) = ui { view.blockLift.drag!!.let { it.cardInWindow() to it.sourceInWindow()!! } }
        // The card is the block's ink plus its insets: it grows by the rows the block gained.
        assertEquals("the card is the block as drawn now", cardBefore + source.height() - tall, card.height(), 4f)
        up(from)
    }

    @Test
    fun aDropFromAboveTheScreenFarDownTheNoteHoldsTheLineAboveTheDropLineStill() {
        val long = (1..2000).map { "row $it of a long note" }
        compose.openDragScreen(long.joinToString("\n")) {
            val target = offsetOf("row 1500 of")
            ui { view.scrollTo(0, view.layout.getLineTop(view.layout.getLineForOffset(target)) - 400) }
            SystemClock.sleep(300)
            val above = offsetOf("row 1499 of")
            val topBefore = ui { view.boundaryY(BlockSlot(above, false))!! - view.scrollY }
            val hold = DropHold(above + 10 - (offsetOf("row 2 of")), topBefore.toInt())
            ui { val e = view.engine!!; e.handler.post { e.moveBlock(0, BlockSlot(target, false), hold) } }
            compose.waitUntil(5_000) { file.readText().startsWith("row 2 of") }
            SystemClock.sleep(1_500)
            val moved = offsetOf("row 1499 of")
            val topAfter = ui { view.boundaryY(BlockSlot(moved, false))!! - view.scrollY }
            assertEquals("the line above the drop line stayed where it was", topBefore, topAfter, 2f)
        }
    }

    /** A long note still streaming in: a hold lifts at once, the UI thread never stalls for the rest, and the drop lands. */
    @Test
    fun aLiftInANoteStillStreamingInStaysResponsive() {
        val lines = (1..60_000).map { if (it % 7 == 0) "## heading $it" else if (it % 3 == 0) "- item **$it** with `code`" else "line $it of a *long* note" }
        compose.openDragScreen(lines.joinToString("\n"), complete = false) {
            assertFalse("the note is still streaming in", ui { view.contentComplete })
            var longest = 0L
            var beat = SystemClock.uptimeMillis()
            var beating = true
            val ticker = object : Runnable {
                override fun run() {
                    val now = SystemClock.uptimeMillis()
                    longest = maxOf(longest, now - beat); beat = now
                    if (beating) view.postDelayed(this, 8)
                }
            }
            ui { beat = SystemClock.uptimeMillis(); view.post(ticker) }
            val from = at(0)
            val pressed = SystemClock.uptimeMillis()
            down(from)
            compose.waitUntil(60_000) { lifted }
            val liftedAfter = SystemClock.uptimeMillis() - pressed
            Log.i("BlockDragStreaming", "lift ${liftedAfter} ms after the press; longest UI stall so far $longest ms")
            val to = at(offsetOf("line 2 of"), 0.9f)
            moveTo(from, to); hold(200); up(to)
            saved((listOf(lines[1], lines[0]) + lines.drop(2)).joinToString("\n"))
            compose.waitUntil(60_000) { ui { view.contentComplete } }
            ui { beating = false }
            Log.i("BlockDragStreaming", "lift ${liftedAfter} ms after the press; longest UI stall $longest ms; ${lines.joinToString("\n").length} chars")
            assertTrue("lifted in $liftedAfter ms", liftedAfter < 1_000)
            assertTrue("the UI thread stalled $longest ms", longest < 300)
        }
    }
}
