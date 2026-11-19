package com.futo.notes.textfirst

import android.graphics.PointF
import android.os.SystemClock
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/**
 * Mason (S23, A4): the insertion handle carried to the note's top edge over a photo taller than the edge zone
 * stalled there, the note not scrolling though there was text above. A handle held in an edge zone scrolls the
 * note past whatever is under it, and its caret lands on the stop nearest the finger.
 */
class TextFirstCaretEdgeScrollTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    private val note = (1..30).joinToString("") { "line $it above\n" } + "\n![tall](tall.png)\n\nafter photo\n" + (1..30).joinToString("\n") { "below $it" }

    /** Tap [word] to put the caret there with the keyboard up, then carry its insertion handle to [edge] (screen y) and hold it. */
    private fun BlockDragRig.carryHandle(word: String, edge: () -> Float) {
        compose.waitUntil(5_000) { ui { view.text!!.getSpans(0, view.length(), TfImage::class.java).all { it.bitmap != null } } }
        ui { view.scrollTo(0, (view.boundaryY(BlockSlot(view.text.toString().indexOf(word), false))!! - view.height * 0.5f).toInt().coerceAtLeast(0)) }
        SystemClock.sleep(300)
        val tap = at(offsetOf(word))
        down(tap); up(tap)
        compose.waitUntil(5_000) { ui { view.isFocused && view.selectionStart == view.selectionEnd } }
        // The keyboard rises and the caret is revealed above it.
        SystemClock.sleep(1_200)
        val handle = ui {
            val l = view.layout
            val line = l.getLineForOffset(view.selectionStart)
            val loc = IntArray(2).also(view::getLocationOnScreen)
            PointF(loc[0] + view.totalPaddingLeft + l.getPrimaryHorizontal(view.selectionStart),
                loc[1] + view.totalPaddingTop - view.scrollY + l.getLineBottom(line) + view.style.dp(14f))
        }
        down(handle)
        moveTo(handle, PointF(handle.x, edge()), steps = 10)
        // Held still in the zone: a few moves in place, as a resting finger sends.
        repeat(15) { hold(100); moveTo(PointF(handle.x, edge()), PointF(handle.x, edge()), steps = 1) }
    }

    private fun BlockDragRig.noteTop() = ui { IntArray(2).also(view::getLocationOnScreen)[1] + view.style.dp(8f) }
    private fun BlockDragRig.noteBottom() = ui { IntArray(2).also(view::getLocationOnScreen)[1] + view.height - view.style.dp(8f) }

    @Test
    fun aHandleHeldAtTheTopEdgeOverATallPhotoScrollsPastIt() = compose.openDragScreen(note, mapOf("tall.png" to png(900, 2400))) {
        carryHandle("after photo") { noteTop() }
        val image = ui { view.text.toString().indexOf("line 30 above") + "line 30 above".length + 1 }
        val caret = ui { view.selectionStart }
        up(PointF(0f, noteTop()))
        assertTrue("the caret at $caret passed above the photo at $image", caret < image)
    }

    @Test
    fun aHandleHeldAtTheBottomEdgeOverATallPhotoScrollsPastIt() = compose.openDragScreen(note, mapOf("tall.png" to png(900, 2400))) {
        carryHandle("line 30 above") { noteBottom() }
        val after = ui { view.text.toString().indexOf("after photo") }
        val caret = ui { view.selectionStart }
        up(PointF(0f, noteBottom()))
        assertTrue("the caret at $caret passed below the photo, to $after or later", caret >= after)
    }

    /** A hold on [word] with the keyboard up selects it; the same finger then carried to the top edge and held there. */
    private fun BlockDragRig.holdThenCarry(word: String, edge: () -> Float): PointF {
        compose.waitUntil(5_000) { ui { view.text!!.getSpans(0, view.length(), TfImage::class.java).first().bitmap != null } }
        ui { view.scrollTo(0, (view.boundaryY(BlockSlot(view.text.toString().indexOf(word), false))!! - view.height * 0.5f).toInt().coerceAtLeast(0)) }
        SystemClock.sleep(300)
        val tap = at(offsetOf(word))
        down(tap); up(tap)
        compose.waitUntil(5_000) { ui { view.isFocused } }
        SystemClock.sleep(1_200)
        val press = at(offsetOf(word))
        down(press); hold(900)
        compose.waitUntil(3_000) { ui { view.selectionStart != view.selectionEnd } }
        moveTo(press, PointF(press.x, edge()), steps = 10)
        repeat(15) { hold(100); moveTo(PointF(press.x, edge()), PointF(press.x, edge()), steps = 1) }
        return PointF(press.x, edge())
    }

    @Test
    fun aHoldDragSelectionHeldAtTheTopEdgeOverATallPhotoScrollsPastIt() = compose.openDragScreen(note, mapOf("tall.png" to png(900, 2400))) {
        val end = holdThenCarry("after") { noteTop() }
        val image = ui { view.text.toString().indexOf("line 30 above") + "line 30 above".length + 1 }
        val start = ui { view.selectionStart }
        up(end)
        assertTrue("the selection's start at $start passed above the photo at $image", start < image)
    }

    @Test
    fun aSelectionHandleHeldAtTheTopEdgeOverATallPhotoScrollsPastIt() = compose.openDragScreen(note, mapOf("tall.png" to png(900, 2400))) {
        val press = holdThenCarry("after") { at(offsetOf("after")).y }
        up(press)
        SystemClock.sleep(500)
        val handle = ui {
            val l = view.layout
            val line = l.getLineForOffset(view.selectionStart)
            val loc = IntArray(2).also(view::getLocationOnScreen)
            PointF(loc[0] + view.totalPaddingLeft + l.getPrimaryHorizontal(view.selectionStart) - view.style.dp(10f),
                loc[1] + view.totalPaddingTop - view.scrollY + l.getLineBottom(line) + view.style.dp(14f))
        }
        down(handle)
        moveTo(handle, PointF(handle.x, noteTop()), steps = 10)
        repeat(15) { hold(100); moveTo(PointF(handle.x, noteTop()), PointF(handle.x, noteTop()), steps = 1) }
        val image = ui { view.text.toString().indexOf("line 30 above") + "line 30 above".length + 1 }
        val start = ui { view.selectionStart }
        up(PointF(handle.x, noteTop()))
        assertTrue("the selection's start at $start passed above the photo at $image", start < image)
    }

    @Test
    fun aHandleHeldAtTheTopEdgeScrollsPastACodeBlockAndATable() = compose.openDragScreen(
        (1..20).joinToString("") { "line $it above\n" } + "\n```js\n" + (1..6).joinToString("\n") { "const c$it = $it" } +
            "\n```\n\n| a | b |\n| --- | --- |\n" + (1..6).joinToString("") { "| r$it | s$it |\n" } + "\nafter table\n" + (1..20).joinToString("\n") { "below $it" },
    ) {
        carryHandle("after table") { noteTop() }
        val code = ui { view.text.toString().indexOf("const c1") }
        val caret = ui { view.selectionStart }
        up(PointF(0f, noteTop()))
        assertTrue("the caret at $caret passed above the code block at $code", caret < code)
    }
}
