package com.futo.notes.textfirst

import android.graphics.PointF
import android.os.SystemClock
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import org.junit.Assert.assertEquals
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

    /**
     * These are about carrying a handle, not about composition. A keyboard that composes the word at the caret as the
     * caret moves (the emulator's AOSP one does) puts a composition under the dragged handle, and on API 34 its window
     * goes away mid-drag (the next injected move finds no target, "Check failed" in the rig). So the keyboard is asked
     * for no suggestions, and composes nothing, for these.
     */
    private fun BlockDragRig.noSuggestions() = ui { view.inputType = view.inputType or android.text.InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS }

    /** Tap [word] to put the caret there with the keyboard up, then carry its insertion handle to [edge] (screen y). */
    private fun BlockDragRig.carryHandle(word: String, retap: Boolean = false, edge: () -> Float): PointF {
        noSuggestions()
        compose.waitUntil(5_000) { ui { view.text!!.getSpans(0, view.length(), TfImage::class.java).all { it.bitmap != null } } }
        ui { view.scrollTo(0, (view.boundaryY(BlockSlot(view.text.toString().indexOf(word), false))!! - view.height * 0.5f).toInt().coerceAtLeast(0)) }
        SystemClock.sleep(300)
        val tap = at(offsetOf(word))
        down(tap); up(tap)
        compose.waitUntil(5_000) { ui { view.isFocused && view.selectionStart == view.selectionEnd } }
        // The keyboard rises and the caret is revealed above it.
        SystemClock.sleep(1_200)
        if (retap) {
            // The handle hides on its own; a tap on the caret brings it back, in a window the platform makes anew.
            SystemClock.sleep(5_000)
            val caret = at(ui { view.selectionStart })
            down(caret); up(caret)
            SystemClock.sleep(1_000)
        }
        val handle = ui {
            val l = view.layout
            val line = l.getLineForOffset(view.selectionStart)
            val loc = IntArray(2).also(view::getLocationOnScreen)
            PointF(loc[0] + view.totalPaddingLeft + l.getPrimaryHorizontal(view.selectionStart),
                loc[1] + view.totalPaddingTop - view.scrollY + l.getLineBottom(line) + view.style.dp(14f))
        }
        down(handle)
        val point = PointF(handle.x, edge())
        moveTo(handle, point, steps = 10)
        return point
    }

    private fun BlockDragRig.holdHandleAtEdge(point: PointF): Unit {
        repeat(15) { hold(100); moveTo(point, point, steps = 1) }
    }

    private fun BlockDragRig.noteTop() = ui { IntArray(2).also(view::getLocationOnScreen)[1] + view.style.dp(8f) }
    private fun BlockDragRig.noteBottom() = ui { IntArray(2).also(view::getLocationOnScreen)[1] + view.height - view.style.dp(8f) }

    @Test
    fun aHandleHeldAtTheTopEdgeOverATallPhotoScrollsPastIt() = compose.openDragScreen(note, mapOf("tall.png" to png(900, 2400))) {
        val point = carryHandle("after photo") { noteTop() }
        ui {
            val before = view.scrollY
            view.bringPointIntoView(0)
            assertEquals("a caret reveal must leave the edge ramp in control", before, view.scrollY)
        }
        holdHandleAtEdge(point)
        val image = ui { view.text.toString().indexOf("line 30 above") + "line 30 above".length + 1 }
        val caret = ui { view.selectionStart }
        up(PointF(0f, noteTop()))
        assertTrue("the caret at $caret passed above the photo at $image", caret < image)
    }

    @Test
    fun aHandleHeldAtTheBottomEdgeOverATallPhotoScrollsPastIt() = compose.openDragScreen(note, mapOf("tall.png" to png(900, 2400))) {
        holdHandleAtEdge(carryHandle("line 30 above") { noteBottom() })
        val after = ui { view.text.toString().indexOf("after photo") }
        val caret = ui { view.selectionStart }
        up(PointF(0f, noteBottom()))
        assertTrue("the caret at $caret passed below the photo, to $after or later", caret >= after)
    }

    /** A hold on [word] with the keyboard up selects it; the same finger then carried to the top edge and held there. */
    private fun BlockDragRig.holdThenCarry(word: String, edge: () -> Float): PointF {
        noSuggestions()
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
        val word = ui { view.text.toString().indexOf("after photo") + "after".length }
        val (start, stop) = ui { view.selectionStart to view.selectionEnd }
        up(end)
        assertTrue("the selection's start at $start passed above the photo at $image", start in 0 until image)
        assertTrue("the selection at $start..$stop still ends after the held word ($word)", stop >= word)
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
        val heldEnd = ui { view.text.toString().indexOf("after") + "after".length }
        val (start, stop) = ui { view.selectionStart to view.selectionEnd }
        up(PointF(handle.x, noteTop()))
        assertTrue("the selection's start at $start passed above the photo at $image", start in 0 until image)
        assertEquals("the selection's end, which no finger held", heldEnd, stop)
    }

    @Test
    fun aHandleHeldAtTheTopEdgeScrollsPastACodeBlockAndATable() = compose.openDragScreen(
        (1..20).joinToString("") { "line $it above\n" } + "\n```js\n" + (1..6).joinToString("\n") { "const c$it = $it" } +
            "\n```\n\n| a | b |\n| --- | --- |\n" + (1..6).joinToString("") { "| r$it | s$it |\n" } + "\nafter table\n" + (1..20).joinToString("\n") { "below $it" },
    ) {
        holdHandleAtEdge(carryHandle("after table") { noteTop() })
        val code = ui { view.text.toString().indexOf("const c1") }
        val caret = ui { view.selectionStart }
        up(PointF(0f, noteTop()))
        assertTrue("the caret at $caret passed above the code block at $code", caret < code)
    }

    @Test
    fun aHandleATapBroughtBackScrollsPastATallPhoto() = compose.openDragScreen(note, mapOf("tall.png" to png(900, 2400))) {
        holdHandleAtEdge(carryHandle("after photo", retap = true) { noteTop() })
        val image = ui { view.text.toString().indexOf("line 30 above") + "line 30 above".length + 1 }
        val caret = ui { view.selectionStart }
        up(PointF(0f, noteTop()))
        assertTrue("the caret at $caret passed above the photo at $image", caret < image)
    }
}
