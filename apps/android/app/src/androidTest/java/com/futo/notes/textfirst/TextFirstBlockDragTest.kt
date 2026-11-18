package com.futo.notes.textfirst

import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.PointF
import android.os.SystemClock
import android.view.InputDevice
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import androidx.activity.ComponentActivity
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import com.futo.notes.NotesStore
import com.futo.notes.localization.LocalLocalization
import com.futo.notes.localization.Localization
import com.futo.notes.ui.theme.FutoNotesTheme
import java.io.File
import java.util.UUID
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/**
 * The long-press block drag with real touches through the window (#444): with the keyboard
 * down a hold lifts the block under the finger, a card follows it and the drop lands at the
 * drop line, as one move of the saved file; the exceptions keep the platform's long-press.
 */
class TextFirstBlockDragTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    private val automation = InstrumentationRegistry.getInstrumentation().uiAutomation

    private class Haptics : DragHaptics {
        var lifts = 0; var ticks = 0; var lands = 0
        override fun lifted() { lifts++ }
        override fun reachedSlot() { ticks++ }
        override fun landed() { lands++ }
    }

    private inner class Rig(val view: TextFirstEditText, val file: File) {
        val haptics = Haptics().also { h -> ui { view.blockLift.haptics = h } }

        fun <T> ui(block: () -> T): T {
            var out: T? = null
            compose.runOnUiThread { out = block() }
            @Suppress("UNCHECKED_CAST") return out as T
        }

        /** The screen point on the row holding display [offset], [fraction] down that row, [x] px into the text. */
        fun at(offset: Int, fraction: Float = 0.5f, x: Float = 60f): PointF = ui {
            val l = view.layout
            val line = l.getLineForOffset(offset)
            val loc = IntArray(2).also(view::getLocationOnScreen)
            val top = l.getLineTop(line)
            PointF(loc[0] + view.totalPaddingLeft + x,
                loc[1] + view.totalPaddingTop - view.scrollY + top + (l.getLineBottom(line) - top) * fraction)
        }

        fun offsetOf(text: String): Int = ui { view.text.toString().indexOf(text) }.also { check(it >= 0) { "no $text" } }

        private var downTime = 0L
        private fun send(action: Int, p: PointF) {
            val e = MotionEvent.obtain(downTime, SystemClock.uptimeMillis(), action, p.x, p.y, 0)
            e.source = InputDevice.SOURCE_TOUCHSCREEN
            try { check(automation.injectInputEvent(e, true)) } finally { e.recycle() }
        }

        fun down(p: PointF) { downTime = SystemClock.uptimeMillis(); send(MotionEvent.ACTION_DOWN, p) }
        fun hold(p: PointF, ms: Long) {
            val until = SystemClock.uptimeMillis() + ms
            while (SystemClock.uptimeMillis() < until) { send(MotionEvent.ACTION_MOVE, p); SystemClock.sleep(30) }
        }
        fun moveTo(from: PointF, to: PointF, steps: Int = 12) {
            for (i in 1..steps) {
                send(MotionEvent.ACTION_MOVE, PointF(from.x + (to.x - from.x) * i / steps, from.y + (to.y - from.y) * i / steps))
                SystemClock.sleep(16)
            }
        }
        fun up(p: PointF) = send(MotionEvent.ACTION_UP, p)

        /** Hold at [from] past the lift, carry the finger to [to], hold there and let go. */
        fun drag(from: PointF, to: PointF) {
            down(from); hold(from, 600); moveTo(from, to); hold(to, 200); up(to)
        }

        val lifted get() = ui { view.blockLift.drag != null }

        fun saved(expected: String) {
            compose.waitUntil(5_000) { file.readText() == expected }
        }
    }

    private fun open(note: String, files: Map<String, ByteArray> = emptyMap(), complete: Boolean = true, check: Rig.() -> Unit) {
        NoteScrollMemory.clear()
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val scratch = File(context.cacheDir, "block-drag-${UUID.randomUUID()}").apply { check(mkdirs()) }
        val root = File(scratch, "vault").apply { check(mkdirs()) }
        val file = File(root, "drag.md").apply { writeText(note) }
        for ((name, bytes) in files) File(root, name).writeBytes(bytes)
        lateinit var store: NotesStore
        compose.runOnUiThread { store = NotesStore(root, File(scratch, "index")) }
        compose.waitUntil(15_000) { store.hasBootstrapped }
        val localization = Localization.fromGeneratedCatalogs(listOf("en"), "en-US")
        compose.setContent {
            FutoNotesTheme(darkTheme = false) {
                CompositionLocalProvider(LocalLocalization provides localization) {
                    TextFirstEditorScreen(store, "drag", false, false, {}, {}, registerLeave = { {} })
                }
            }
        }
        fun find(view: View): TextFirstEditText? = when (view) {
            is TextFirstEditText -> view
            is ViewGroup -> (0 until view.childCount).firstNotNullOfOrNull { find(view.getChildAt(it)) }
            else -> null
        }
        var editor: TextFirstEditText? = null
        compose.waitUntil(15_000) {
            compose.runOnUiThread {
                editor = find(compose.activity.window.decorView)?.takeIf { it.liftAllowed() && it.length() > 1 && (!complete || it.contentComplete) }
            }
            editor != null
        }
        // The bare test activity has no AppCompat theme, so the EditText style that makes it focusable is absent.
        compose.runOnUiThread { editor!!.isFocusableInTouchMode = true }
        try {
            Rig(editor!!, file).check()
        } finally {
            scratch.deleteRecursively()
        }
    }

    @Test
    fun aHoldLiftsALineWithTheKeyboardDownAndDropsItAtTheDropLine() = open("alpha\nbravo\ncharlie\ndelta") {
        val from = at(0)
        down(from)
        hold(from, 600)
        assertTrue("held past 340 ms, the line lifts", lifted)
        assertEquals(1, haptics.lifts)
        // Below delta's middle the drop line is the note's end.
        val to = at(offsetOf("delta"), 0.9f)
        moveTo(from, to)
        hold(to, 200)
        assertTrue(ui { view.blockLift.drag?.slot } == BlockSlot(ui { view.length() - 1 }, true))
        up(to)
        saved("bravo\ncharlie\ndelta\nalpha")
        assertEquals("one landing haptic", 1, haptics.lands)
        assertTrue("a tick for each new slot the finger reached", haptics.ticks >= 3)
        assertFalse("a lift starts no editing", ui { view.isFocused })
        assertFalse(lifted)
    }

    @Test
    fun aReleaseOverItsOwnPlaceMovesNothingSilently() = open("alpha\nbravo\ncharlie") {
        val from = at(offsetOf("bravo"))
        down(from); hold(from, 600)
        assertTrue(lifted)
        val near = at(offsetOf("bravo"), 0.8f)
        moveTo(from, near, steps = 3); hold(near, 150); up(near)
        SystemClock.sleep(700)
        assertEquals("alpha\nbravo\ncharlie", file.readText())
        assertEquals(0, haptics.lands)
        assertEquals(0, haptics.ticks)
    }

    @Test
    fun withTheNoteFocusedOrOnABlankLineALongPressIsThePlatforms() = open("alpha bravo\n\ncharlie") {
        // A blank line lifts nothing: the platform's long press takes the touch (and focuses the note).
        val blank = at(offsetOf("charlie") - 1)
        down(blank); hold(blank, 800); up(blank)
        assertFalse(lifted)
        compose.waitUntil(3_000) { ui { view.isFocused } }
        // Let the keyboard finish rising (the view shrinks under it) before aiming at a word.
        SystemClock.sleep(1_000)
        // Now the note is focused: a hold anywhere is the platform's (word selection), nothing lifts.
        val word = at(offsetOf("alpha"), x = 20f)
        down(word); hold(word, 800)
        assertFalse(lifted)
        up(word)
        assertEquals("alpha bravo\n\ncharlie", file.readText())
    }

    @Test
    fun aPhotoSharingItsLineLiftsAloneAndATableLiftsWhole() {
        val png = java.io.ByteArrayOutputStream().also {
            Bitmap.createBitmap(300, 200, Bitmap.Config.ARGB_8888).apply { eraseColor(Color.CYAN) }.compress(Bitmap.CompressFormat.PNG, 100, it)
        }.toByteArray()
        open("Nice!![](p.png)\nnext\n| a | b |\n|---|---|\n| 1 | 2 |\n\nend", mapOf("p.png" to png)) {
            compose.waitUntil(5_000) { ui { view.text!!.getSpans(0, view.length(), TfImage::class.java).first().bitmap != null } }
            val photo = ui {
                val image = view.text!!.getSpans(0, view.length(), TfImage::class.java).first()
                val r = checkNotNull(view.imageRect(image))
                val loc = IntArray(2).also(view::getLocationOnScreen)
                PointF(loc[0] + r.centerX(), loc[1] + r.centerY() - view.scrollY)
            }
            drag(photo, at(offsetOf("next"), 0.9f))
            saved("Nice!\nnext\n![](p.png)\n| a | b |\n|---|---|\n| 1 | 2 |\n\nend")
            // On the table's grid: the whole table lifts.
            val grid = ui { view.tableRowAt(at(offsetOf("1")).y - IntArray(2).also(view::getLocationOnScreen)[1]) }
            assertNotNull(grid)
            drag(at(offsetOf("1"), x = 30f), at(offsetOf("end"), 0.9f))
            saved("Nice!\nnext\n![](p.png)\n\nend\n| a | b |\n|---|---|\n| 1 | 2 |")
        }
    }

    @Test
    fun aChangeToTheNoteMidDragCancelsItWithNothingMoved() = open("alpha\nbravo\ncharlie") {
        val from = at(0)
        down(from); hold(from, 600)
        assertTrue(lifted)
        val to = at(offsetOf("charlie"), 0.9f)
        moveTo(from, to)
        // An edit lands from elsewhere (as a sync would), while the finger is still down.
        ui { view.engine!!.hostSelect(0, 0) }
        ui { view.engine!!.paste("Z") }
        compose.waitUntil(3_000) { !lifted }
        hold(to, 100); up(to)
        saved("Zalpha\nbravo\ncharlie")
        assertEquals(0, haptics.lands)
    }

    @Test
    fun aLiftInANoteStillStreamingInFinishesLoadingFirst() {
        val lines = (1..20000).map { "line $it of a long note" }
        open(lines.joinToString("\n"), complete = false) {
            assertFalse("the note is still streaming in", ui { view.contentComplete })
            val from = at(0)
            down(from); hold(from, 600)
            assertTrue(lifted)
            assertTrue("the lift loaded the whole note", ui { view.contentComplete })
            val to = at(offsetOf("line 3 of"), 0.9f)
            moveTo(from, to); hold(to, 200); up(to)
            saved((listOf(lines[1], lines[2], lines[0]) + lines.drop(3)).joinToString("\n"))
        }
    }

    @Test
    fun heldAtTheBottomEdgeTheNoteScrollsAndTheDropLandsWhereTheLineShows() {
        val lines = (1..80).map { "row $it" }
        open(lines.joinToString("\n")) {
            val from = at(0)
            down(from); hold(from, 600)
            assertTrue(lifted)
            val edge = ui { val loc = IntArray(2).also(view::getLocationOnScreen); PointF(loc[0] + 100f, loc[1] + view.height - 4f) }
            val ticks = haptics.ticks
            moveTo(from, edge)
            hold(edge, 1200)
            assertTrue("the note scrolled", ui { view.scrollY } > 600)
            assertTrue("no ticks from the scroll alone", haptics.ticks - ticks < 20)
            // Back out of the zone the scroll stops; the drop lands where the drop line shows.
            val inside = PointF(edge.x, edge.y - 300f)
            moveTo(edge, inside, steps = 4); hold(inside, 300)
            val slot = checkNotNull(ui { view.blockLift.drag?.slot })
            val below = ui { view.text!!.substring(slot.offset).substringBefore('\n') }
            up(inside)
            val moved = lines.drop(1).toMutableList().apply { add(indexOf(below), lines[0]) }
            saved(moved.joinToString("\n"))
            assertTrue("dropped far below the first screen", moved.indexOf("row 1") > 20)
        }
    }
}
