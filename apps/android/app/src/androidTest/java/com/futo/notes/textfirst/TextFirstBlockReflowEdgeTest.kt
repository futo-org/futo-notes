package com.futo.notes.textfirst

import android.graphics.PointF
import android.graphics.RectF
import android.os.SystemClock
import android.view.ViewGroup
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/** The reflow preview at its edges (#450): the release handoff, a slow editor, a cut view, a tall preview, a photo going home. */
class TextFirstBlockReflowEdgeTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    private fun BlockDragRig.right() = ui { IntArray(2).also(view::getLocationOnScreen)[0] + view.width * 0.85f }
    private fun BlockDragRig.bottomEdge() = ui { IntArray(2).also(view::getLocationOnScreen).let { PointF(it[0] + view.width * 0.85f, it[1] + view.height - 4f) } }
    private fun BlockDragRig.photoCentre(index: Int): PointF = ui {
        val image = view.text!!.getSpans(0, view.length(), TfImage::class.java)[index]
        val r = checkNotNull(view.imageRect(image))
        val loc = IntArray(2).also(view::getLocationOnScreen)
        PointF(loc[0] + r.centerX(), loc[1] + r.centerY() - view.scrollY)
    }
    private fun BlockDragRig.decoded() = compose.waitUntil(5_000) { ui { view.text!!.getSpans(0, view.length(), TfImage::class.java).all { it.bitmap != null } } }

    /** Released before any frame drew the open gap: the landing starts where the block showed, and never jumps back. */
    @Test
    fun releasedTheMomentTheGapOpensTheBlockLandsFromWhereItShowed() = compose.openDragScreen((1..12).joinToString("\n") { "line $it" }) {
        val from = at(offsetOf("line 8"))
        val homeTop = ui { viewInWindow() + view.boundaryY(BlockSlot(offsetOf("line 8"), false))!! - view.scrollY }
        startDirect()
        dispatch(android.view.MotionEvent.ACTION_DOWN, listOf(from))
        hold(600)
        val past = at(offsetOf("line 9"), 0.85f)
        moveThenLift(past)
        val tops = ArrayList<Float>()
        val until = SystemClock.uptimeMillis() + 1_500
        while (SystemClock.uptimeMillis() < until) {
            val r = ui { view.blockLift.drag?.reflow?.report() } ?: break
            r.copy?.let { tops += it.top }
            SystemClock.sleep(4)
        }
        saved((1..12).map { "line $it" }.toMutableList().apply { removeAt(7); add(8, "line 8") }.joinToString("\n"))
        assertTrue("the drop was watched", tops.isNotEmpty())
        val line = ui { view.lineHeight.toFloat() }
        assertEquals("the landing starts where the block showed", homeTop, tops.first(), line)
        for ((a, b) in tops.zipWithNext()) assertTrue("it never jumps back ($a then $b)", b >= a - 2f)
    }

    /** The editor takes longer than the 400 ms cap to make the move: the preview and the lift exclusion end at the cap, the move still lands. */
    @Test
    fun aDropTheEditorIsSlowToMakeEndsThePreviewAtTheCap() = compose.openDragScreen("alpha\nbravo\ncharlie\ndelta") {
        val from = at(0)
        down(from); hold(600)
        val at = carryUntil(from, 8f, right()) { report?.gap == BlockSlot(offsetOf("delta"), false) }
        SystemClock.sleep(250)
        ui { view.engine!!.handler.post { SystemClock.sleep(1_500) } }
        val released = SystemClock.uptimeMillis()
        up(at)
        compose.waitUntil(1_000) { !lifted }
        assertTrue("the preview ended at the cap", SystemClock.uptimeMillis() - released < 700)
        assertEquals("the move is still on its way", "alpha\nbravo\ncharlie\ndelta", file.readText())
        saved("bravo\ncharlie\nalpha\ndelta")
    }

    /** A new width cuts a long view to a prefix that no longer holds the lifted block: a release then moves nothing. */
    @Test
    fun aWidthChangeThatCutsTheBlockOutOfTheViewMovesNothingAtTheRelease() {
        val rows = (1..1200).map { "row $it of a note long enough to be cut" }
        compose.openDragScreen(rows.joinToString("\n")) {
            val target = offsetOf("row 1000 of")
            ui { view.scrollTo(0, view.layout.getLineTop(view.layout.getLineForOffset(target)) - 200) }
            SystemClock.sleep(300)
            val from = at(target)
            down(from); hold(600)
            assertTrue(lifted)
            val at = carryUntil(from, 8f, right()) { report?.gap != null }
            // The editor thread is busy, so the rest of the note cannot stream back before the release.
            ui { view.engine!!.handler.post { SystemClock.sleep(2_000) } }
            // What a new width does to a long view first: it keeps a bounded prefix and the engine streams the rest.
            assertTrue("the view was cut", ui { view.boundForRelayout() })
            assertTrue(ui { view.length() < 20_000 })
            up(at)
            SystemClock.sleep(3_500)
            assertEquals(rows.joinToString("\n"), file.readText())
            assertEquals(0, haptics.lands)
        }
    }

    /** A photo leaving a row it shares with a taller-than-the-gap sibling makes the preview taller: autoscroll still reaches the note's end. */
    @Test
    fun aPhotoLeavingARowItSharesStillReachesTheEndOfTheNote() {
        val rows = (1..40).map { "row $it" }
        compose.openDragScreen("![](a.png)![](b.png)\n" + rows.joinToString("\n"), mapOf("a.png" to png(120, 900), "b.png" to png(120, 900))) {
            decoded()
            val photo = photoCentre(0)
            down(photo); hold(600)
            assertTrue(lifted)
            moveTo(photo, bottomEdge(), steps = 6)
            compose.waitUntil(10_000) { report?.gap == ui { BlockSlot(view.length() - 1, true) } }
            up(bottomEdge())
            saved("![](b.png)\n" + rows.joinToString("\n") + "\n![](a.png)")
        }
    }

    /** Carried away and back into its line, a photo is reported where the preview draws it: its own box in the line. */
    @Test
    fun aPhotoCarriedBackIntoItsLineIsReportedWhereItIsDrawn() =
        compose.openDragScreen("Nice!![](p.png)\nnext\nend", mapOf("p.png" to png(300, 200))) {
            decoded()
            val photo = photoCentre(0)
            down(photo); hold(600)
            val away = carryUntil(photo, 8f, right()) { report?.gap != null }
            SystemClock.sleep(300)
            carryUntil(away, -4f, right()) { report?.gap == null }
            val (copy, image) = ui {
                val at = IntArray(2).also(view::getLocationInWindow)
                val r = view.imageRect(view.text!!.getSpans(0, view.length(), TfImage::class.java).first())!!
                report!!.copy!! to RectF(at[0] + r.left, at[1] + r.top - view.scrollY, at[0] + r.right, at[1] + r.bottom - view.scrollY)
            }
            assertEquals(image.left, copy.left, 2f)
            assertEquals(image.top, copy.top, 2f)
            assertEquals(image.right, copy.right, 2f)
            assertEquals(image.bottom, copy.bottom, 2f)
        }

    /** The note view leaving while a drop lands takes the preview with it. */
    @Test
    fun theNoteClosingWhileADropLandsTakesThePreviewDownWithIt() = compose.openDragScreen("alpha\nbravo\ncharlie") {
        val from = at(0)
        down(from); hold(600)
        val at = carryUntil(from, 8f, right()) { report?.gap != null }
        // The editor answers late, so the drop is still landing when the view goes.
        ui { view.engine!!.handler.post { SystemClock.sleep(300) } }
        up(at)
        assertTrue("the drop is still landing", ui { view.blockLift.drag != null })
        ui { (view.parent as ViewGroup).removeView(view) }
        assertNull("no preview outlives its editor", ui { view.blockLift.drag })
    }
}
