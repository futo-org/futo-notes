package com.futo.notes.textfirst

import android.graphics.PointF
import android.os.SystemClock
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/**
 * The block drag's live reflow (#450) with real touches through the window: the preview's gap
 * and dimmed copy are drawn where the debug report says, and the drop lands there, as the
 * saved file and the laid-out note show, without the view scrolling.
 */
class TextFirstBlockReflowTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    private fun BlockDragRig.lineStart(text: String) = ui { view.text!!.toString().let { t -> t.lastIndexOf('\n', t.indexOf(text)) + 1 } }
    private fun BlockDragRig.right() = ui { IntArray(2).also(view::getLocationOnScreen)[0] + view.width * 0.85f }

    /**
     * Lift the line holding [block], carry it ([step] px a frame) until the preview's gap is at
     * [slot] and let go: the copy was drawn dimmed in the gap, the note is saved as [expected],
     * and the moved block is laid out where its copy was drawn, the view not scrolled.
     */
    private fun BlockDragRig.dropWhereShown(block: String, step: Float, slot: () -> BlockSlot, expected: String, from: PointF = at(offsetOf(block))) {
        down(from); hold(600)
        assertTrue("lifted", lifted)
        val wanted = slot()
        val at = carryUntil(from, step, right()) { report?.gap == wanted }
        assertTrue("the gap opened", report!!.opened)
        assertCopyDrawn()
        assertEquals("the gap held still", wanted, report?.gap)
        val copyTop = report!!.copy!!.top
        val scrolled = ui { view.scrollY }
        up(at)
        saved(expected)
        compose.waitUntil(2_000) { !lifted }
        assertEquals("the view does not scroll at the drop", scrolled, ui { view.scrollY })
        val landed = ui { viewInWindow() + view.boundaryY(BlockSlot(lineStart(block), false))!! - view.scrollY }
        val line = ui { view.lineHeight.toFloat() }
        assertEquals("the block is laid out where its copy was drawn", copyTop, landed, line / 4)
        assertEquals("one drop haptic", 1, haptics.lands)
    }

    @Test
    fun aLineCarriedToTheFirstLineLandsWhereItsCopyWasDrawn() = compose.openDragScreen("alpha\nbravo\ncharlie\ndelta") {
        val source = at(offsetOf("charlie"))
        down(source); hold(600)
        val place = ui { view.blockLift.drag!!.sourceInWindow()!! }
        val at = carryUntil(source, -8f, right()) { report?.gap == BlockSlot(0, false) }
        assertCopyDrawn()
        // Its place closed: bravo is drawn there now, solid.
        val (_, darkest) = ink(screenshot(), android.graphics.RectF(ui { view.totalPaddingLeft.toFloat() }, place.top + 2, place.right / 2, place.bottom - 2))
        assertTrue("the block's place shows solid text, not its dimmed copy ($darkest)", darkest < 100)
        assertEquals("a tick for each new gap: above bravo, above alpha", 2, haptics.ticks)
        up(at)
        saved("charlie\nalpha\nbravo\ndelta")
        compose.waitUntil(2_000) { !lifted }
    }

    @Test
    fun aLineCarriedPastTheLastLineLandsWhereItsCopyWasDrawn() = compose.openDragScreen("alpha\nbravo\ncharlie\ndelta") {
        dropWhereShown("alpha", 8f, { ui { BlockSlot(view.length() - 1, true) } }, "bravo\ncharlie\ndelta\nalpha")
        assertEquals("a tick for each new gap: above charlie, above delta, the end", 3, haptics.ticks)
    }

    @Test
    fun aListItemDroppedInsideItsListLandsWhereItsCopyWasDrawn() = compose.openDragScreen("- one\n- two\n- three\n- four\n\nafter") {
        dropWhereShown("one", 8f, { BlockSlot(lineStart("four"), false) }, "- two\n- three\n- one\n- four\n\nafter")
    }

    @Test
    fun aLineDroppedAboveAHeadingLandsWhereItsCopyWasDrawn() = compose.openDragScreen("# Title\nalpha\n## Section\nbravo\ncharlie") {
        dropWhereShown("charlie", -8f, { BlockSlot(lineStart("Section"), false) }, "# Title\nalpha\ncharlie\n## Section\nbravo")
    }

    /** The gap shows the block as it was; what it becomes in a checklist appears as it lands. */
    @Test
    fun aPlainLineDroppedIntoAChecklistLandsThereAsATask() = compose.openDragScreen("- [ ] milk\n- [ ] eggs\n\nplain\nend") {
        dropWhereShown("plain", -8f, { BlockSlot(lineStart("eggs"), false) }, "- [ ] milk\n- [ ] plain\n- [ ] eggs\n\nend")
    }

    @Test
    fun theGapFollowsTheContentWhileTheNoteAutoscrollsAndTheDropLandsWhereShown() {
        val rows = (1..200).map { "row $it" }
        compose.openDragScreen(rows.joinToString("\n")) {
            val from = at(0)
            down(from); hold(600)
            val edge = ui { IntArray(2).also(view::getLocationOnScreen).let { PointF(it[0] + view.width * 0.85f, it[1] + view.height - 4f) } }
            moveTo(from, edge)
            val gap = report?.gap
            val ticks = haptics.ticks
            hold(2_500)
            // Far enough that the block's own place is screens away: its copy is still drawn.
            assertTrue("the note scrolled two screens under the still finger", ui { view.scrollY > 2 * view.height })
            assertNotEquals("the gap followed the content under the finger", gap, report?.gap)
            assertEquals("no ticks from the scroll alone", ticks, haptics.ticks)
            // Out of the edge zone the scroll stops; the drop lands where the preview shows it.
            val inside = PointF(edge.x, edge.y - 300f)
            moveTo(edge, inside, steps = 4); hold(300)
            assertCopyDrawn()
            val slot = checkNotNull(report?.gap)
            val below = ui { view.text!!.substring(slot.offset).substringBefore('\n') }
            val copyTop = report!!.copy!!.top
            val scrolled = ui { view.scrollY }
            up(inside)
            saved(rows.drop(1).toMutableList().apply { add(indexOf(below), rows[0]) }.joinToString("\n"))
            compose.waitUntil(2_000) { !lifted }
            assertEquals("the view does not scroll at the drop", scrolled, ui { view.scrollY })
            val landed = ui { viewInWindow() + view.boundaryY(BlockSlot(view.text!!.indexOf("row 1\n"), false))!! - view.scrollY }
            assertEquals(copyTop, landed, ui { view.lineHeight / 4f })
        }
    }

    /** The text column narrows with the gap open (as a rotation would): the copy is measured again, the drag carries on and lands where shown. */
    @Test
    fun aLayoutChangeWithTheGapOpenMeasuresAgainAndTheDropLandsWhereShown() =
        compose.openDragScreen("alpha is a line long enough to wrap when the note gets narrow enough\nbravo\ncharlie\ndelta") {
            val from = at(0)
            down(from); hold(600)
            val at = carryUntil(from, 8f, right()) { report?.gap == BlockSlot(offsetOf("charlie"), false) }
            val tall = report!!.copy!!.height()
            ui { view.setPadding(view.paddingLeft, view.paddingTop, view.width / 2, view.paddingBottom) }
            compose.waitUntil(3_000) { (report?.copy?.height() ?: 0f) > tall * 1.5f }
            assertEquals("the gap stayed", BlockSlot(offsetOf("charlie"), false), report?.gap)
            val source = ui { view.blockLift.drag!!.sourceInWindow()!! }
            assertEquals("the copy is the block as laid out now", source.height(), report!!.copy!!.height(), 1f)
            assertCopyDrawn()
            val copyTop = report!!.copy!!.top
            up(at)
            saved("bravo\nalpha is a line long enough to wrap when the note gets narrow enough\ncharlie\ndelta")
            compose.waitUntil(2_000) { !lifted }
            val landed = ui { viewInWindow() + view.boundaryY(BlockSlot(offsetOf("alpha"), false))!! - view.scrollY }
            assertEquals(copyTop, landed, ui { view.lineHeight / 4f })
        }

    /** While a dropped block slides into place nothing else lifts: a hold that starts then is the platform's. */
    @Test
    fun noBlockLiftsWhileTheDroppedOneLands() = compose.openDragScreen("alpha\nbravo\ncharlie\ndelta") {
        val from = at(0)
        down(from); hold(600)
        val at = carryUntil(from, 8f, right()) { report?.gap == BlockSlot(offsetOf("charlie"), false) }
        up(at)
        val press = at(offsetOf("delta"))
        down(press)
        assertTrue("the drop is still landing", ui { view.blockLift.drag != null })
        hold(600)
        assertEquals("the landing drag ended and none lifted", null, ui { view.blockLift.drag })
        up(press)
        saved("bravo\nalpha\ncharlie\ndelta")
        assertEquals(1, haptics.lifts)
    }

    /** A photo lifted out of `Nice!![](p.png)`: its line closes to the text without it and it lands as a line of its own, where its copy was drawn. */
    @Test
    fun aPhotoLiftedOutOfItsLineLandsAsALineOfItsOwnWhereItsCopyWasDrawn() =
        compose.openDragScreen("Nice!![](p.png)\nnext\nend", mapOf("p.png" to png(300, 200))) {
            compose.waitUntil(5_000) { ui { view.text!!.getSpans(0, view.length(), TfImage::class.java).first().bitmap != null } }
            val photo = ui {
                val r = checkNotNull(view.imageRect(view.text!!.getSpans(0, view.length(), TfImage::class.java).first()))
                val loc = IntArray(2).also(view::getLocationOnScreen)
                PointF(loc[0] + r.centerX(), loc[1] + r.centerY() - view.scrollY)
            }
            down(photo); hold(600)
            assertTrue(lifted)
            val at = carryUntil(photo, 8f, right()) { report?.gap == BlockSlot(lineStart("end"), false) }
            SystemClock.sleep(Slide.SLIDE_MS + 120)
            val copy = report!!.copy!!
            val (count, _) = ink(screenshot(), android.graphics.RectF(ui { view.totalPaddingLeft.toFloat() + 4 }, copy.top + 4, ui { view.totalPaddingLeft.toFloat() + 40 }, copy.bottom - 8))
            assertTrue("the photo's copy is drawn in the gap", count > 20)
            val copyTop = copy.top
            up(at)
            saved("Nice!\nnext\n![](p.png)\nend")
            compose.waitUntil(2_000) { !lifted }
            val landed = ui {
                val image = view.text!!.getSpans(0, view.length(), TfImage::class.java).first()
                viewInWindow() + view.boundaryY(BlockSlot(view.text!!.getSpanStart(image), false))!! - view.scrollY
            }
            assertEquals("the photo is laid out where its copy was drawn", copyTop, landed, ui { view.lineHeight / 4f })
        }
}
