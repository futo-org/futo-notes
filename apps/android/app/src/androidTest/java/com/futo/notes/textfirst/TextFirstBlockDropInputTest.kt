package com.futo.notes.textfirst

import android.graphics.PointF
import android.os.SystemClock
import android.view.InputDevice
import android.view.MotionEvent
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/** Input that comes while a lift is asked for, a drop is made or lands (Sol review of !716, 1, 2 and 4). */
class TextFirstBlockDropInputTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    /** A touch handed to the note now, at screen point [p]. */
    private fun BlockDragRig.dispatch(action: Int, downTime: Long, p: PointF) {
        val at = IntArray(2).also(view::getLocationOnScreen)
        val e = MotionEvent.obtain(downTime, SystemClock.uptimeMillis(), action, p.x - at[0], p.y - at[1], 0)
        e.source = InputDevice.SOURCE_TOUCHSCREEN
        try { view.dispatchTouchEvent(e) } finally { e.recycle() }
    }

    private fun BlockDragRig.right() = ui { IntArray(2).also(view::getLocationOnScreen)[0] + view.width * 0.85f }

    @Test
    fun aTapThatGoesDownWhileTheDropIsMadeIsSwallowedWhole() = compose.openDragScreen((1..100).joinToString("\n") { "line $it" }) {
        ui { check(view.selectionStart == 0 && view.selectionEnd == 0) { "the caret starts at the top" } }
        ui { view.scrollTo(0, view.totalPaddingTop + view.layout.getLineTop(55)) }
        SystemClock.sleep(300)
        val from = at(offsetOf("line 60"))
        down(from); hold(600)
        assertTrue("lifted", lifted)
        val at = carryUntil(from, 8f, right()) { (report?.gap?.offset ?: 0) > offsetOf("line 61") }
        SystemClock.sleep(Slide.SLIDE_MS + 120)
        val scrolled = ui { view.scrollY }
        val tap = SystemClock.uptimeMillis()
        // The release and a new tap's DOWN in one go: the editor has still to make the move.
        ui {
            moveThenLift(at)
            dispatch(MotionEvent.ACTION_DOWN, tap, from)
        }
        // The move made (the view shows it), and the tap lifts as a tap would, well inside a long press.
        compose.waitUntil(2_000) { ui { view.text.toString().let { it.indexOf("line 60") > it.indexOf("line 61") } } }
        ui { dispatch(MotionEvent.ACTION_UP, tap, from) }
        check(SystemClock.uptimeMillis() - tap < android.view.ViewConfiguration.getLongPressTimeout()) { "the tap lasted a long press" }
        compose.waitUntil(5_000) { !file.readText().contains("line 60\nline 61") }
        compose.waitUntil(2_000) { !lifted }
        SystemClock.sleep(500)
        assertEquals("the scroll after the swallowed tap", scrolled, ui { view.scrollY })
        assertEquals("the caret after the swallowed tap", 0, ui { view.selectionStart })
    }

    @Test
    fun aTapWhileTheDropLandsChecksNoBox() = compose.openDragScreen("- [ ] alpha\n- [ ] bravo\n- [ ] charlie\n- [ ] delta") {
        val from = at(offsetOf("alpha"))
        down(from); hold(600)
        assertTrue("lifted", lifted)
        val at = carryUntil(from, 8f, right()) { report?.gap == BlockSlot(ui { view.length() - 1 }, true) }
        SystemClock.sleep(Slide.SLIDE_MS + 120)
        val box = ui {
            val l = view.layout
            val loc = IntArray(2).also(view::getLocationOnScreen)
            PointF(loc[0] + view.totalPaddingLeft + l.getPrimaryHorizontal(view.text.toString().indexOf("alpha")) - view.style.listIndent / 2f,
                loc[1] + view.totalPaddingTop - view.scrollY + (l.getLineTop(0) + l.getLineBottom(0)) / 2f)
        }
        up(at)
        // The move applied and its landing still sliding: a tap on the top box, where alpha still shows.
        val tap = SystemClock.uptimeMillis()
        compose.waitUntil(5_000) {
            ui {
                val text = view.text.toString()
                val landing = view.blockLift.drag?.landing == true && text.indexOf("alpha") > text.indexOf("delta")
                if (landing) { dispatch(MotionEvent.ACTION_DOWN, tap, box); dispatch(MotionEvent.ACTION_UP, tap, box) }
                landing
            }
        }
        compose.waitUntil(2_000) { !lifted }
        compose.waitUntil(5_000) { file.readText().endsWith("alpha") }
        // A box the tap checked is saved after the move.
        SystemClock.sleep(2_500)
        assertEquals("the note after a tap on a landing drop", "- [ ] bravo\n- [ ] charlie\n- [ ] delta\n- [ ] alpha", file.readText())
    }

    @Test
    fun aFieldFocusedWhileTheLiftIsAskedForLiftsNothing() = compose.openDragScreen("alpha\nbravo\ncharlie") {
        val from = at(offsetOf("bravo"))
        // The editor busy: the lift's question waits for it.
        ui { view.engine!!.handler.post { SystemClock.sleep(1_500) } }
        down(from); hold(600)
        ui { view.requestFocus() }
        SystemClock.sleep(1_500)
        assertTrue("nothing lifted", !lifted)
        assertEquals("no lift haptic", 0, haptics.lifts)
        up(from)
    }
}
