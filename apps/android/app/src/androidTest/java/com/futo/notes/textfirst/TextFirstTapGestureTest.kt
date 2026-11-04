package com.futo.notes.textfirst

import android.os.SystemClock
import android.view.MotionEvent
import android.view.ViewGroup
import androidx.activity.ComponentActivity
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.util.UUID
import kotlin.coroutines.resume
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.junit.Assert.*
import org.junit.Test
import uniffi.futo_notes_ffi.NoteStore

/** Real taps on the note: an external link opens, a double-tap selects a word, a triple-tap a line. */
class TextFirstTapGestureTest {
    private val source = "alpha beta gamma\n\nsee https://example.com now and www.example.org too\n\n[label](https://label.example) end"

    private fun exercise(source: String = this.source, check: suspend Rig.() -> Unit) = runBlocking {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val root = File(context.cacheDir, "tap-gesture-${UUID.randomUUID()}").apply { check(mkdirs()) }
        val scenario = ActivityScenario.launch(ComponentActivity::class.java)
        val width = (360 * context.resources.displayMetrics.density).toInt()
        val store = NoteStore(root.path)
        lateinit var controller: TextFirstController
        try {
            store.createNote("taps", "", source)
            withContext(Dispatchers.Main) {
                suspendCancellableCoroutine<Unit> { done ->
                    scenario.onActivity { activity ->
                        controller = createTextFirstController(activity, { store }, root)
                        activity.setContentView(controller.view, ViewGroup.LayoutParams(width, 1600))
                        controller.open("taps") { assertNull(it); done.resume(Unit) }
                    }
                }
                val view = controller.view
                withTimeout(10_000) { while (!(view.isLaidOut && view.width == width && view.layout != null)) delay(20) }
                // The bare test activity has no AppCompat theme, so the EditText style that makes it focusable is absent.
                view.isFocusableInTouchMode = true
                view.requestFocus()
                delay(300L)
                Rig(view, controller).check()
            }
        } finally {
            withContext(Dispatchers.Main) { controller.discard(); controller.dispose() }
            scenario.close()
            store.destroy()
            root.deleteRecursively()
        }
    }

    private class Rig(val view: TextFirstEditText, val controller: TextFirstController) {
        val text get() = view.editableText.toString()

        /** The point in the middle of [needle]'s [index]th character. */
        fun pointAt(needle: String, index: Int = needle.length / 2): Pair<Float, Float> {
            val offset = text.indexOf(needle).also { check(it >= 0) { "'$needle' not in '$text'" } } + index
            val layout = view.layout
            val line = layout.getLineForOffset(offset)
            val x = (layout.getPrimaryHorizontal(offset) + layout.getPrimaryHorizontal(offset + 1)) / 2
            val y = (layout.getLineTop(line) + layout.getLineBottom(line)) / 2f
            return view.totalPaddingLeft + x to view.totalPaddingTop + y
        }

        /** The gesture clock: events carry their own times, so a stalled main thread cannot stretch a double-tap. */
        private var clock = SystemClock.uptimeMillis()

        /** [count] quick taps at one point, 100 ms apart by their own timestamps; returns when the last one is up. */
        suspend fun taps(point: Pair<Float, Float>, count: Int, drift: FloatArray = floatArrayOf()) {
            clock = maxOf(clock + 1_000L, SystemClock.uptimeMillis())
            repeat(count) {
                val down = clock
                val path = listOf(MotionEvent.ACTION_DOWN to 0f) + drift.dropLast(1).map { MotionEvent.ACTION_MOVE to it } +
                    (MotionEvent.ACTION_UP to (drift.lastOrNull() ?: 0f))
                path.forEachIndexed { step, (action, dx) ->
                    val e = MotionEvent.obtain(down, down + 40L * step / path.lastIndex, action, point.first + dx, point.second, 0)
                    try { view.dispatchTouchEvent(e) } finally { e.recycle() }
                }
                clock += 100L
            }
            controller.sourceText()
        }

        fun selected() = text.substring(view.selectionStart, view.selectionEnd)
    }

    @Test
    fun aDoubleTapSelectsTheWord() = exercise {
        view.setSelection(0)
        taps(pointAt("beta"), 2)
        delay(500L)
        assertEquals("fresh double tap: sel ${view.selectionStart}-${view.selectionEnd}", "beta", selected())
    }

    @Test
    fun aDoubleTapOnAnUnfocusedNoteSelectsTheWord() = exercise {
        view.clearFocus()
        view.setSelection(0)
        taps(pointAt("beta"), 2)
        delay(500L)
        assertEquals("unfocused double tap: sel ${view.selectionStart}-${view.selectionEnd} focused=${view.isFocused}", "beta", selected())
    }

    @Test
    fun aDoubleTapWithAFingersJitterSelectsTheWord() = exercise {
        view.setSelection(0)
        val (x, y) = pointAt("gamma")
        // A finger drifts a few px between touching down and lifting.
        taps(x to y, 2, drift = floatArrayOf(2f, 4f, 5f))
        delay(500L)
        assertEquals("jittery double tap: sel ${view.selectionStart}-${view.selectionEnd}", "gamma", selected())
    }

    /** Gboard marks the word the caret lands in; the second tap of a double-tap arrives with that composition open. */
    @Test
    fun aDoubleTapSelectsTheWordWhileTheKeyboardMarksIt() = exercise {
        view.setSelection(0)
        val connection = view.onCreateInputConnection(android.view.inputmethod.EditorInfo())!!
        taps(pointAt("beta"), 1)
        controller.sourceText()
        val start = text.indexOf("beta")
        connection.setComposingRegion(start, start + 4)
        controller.sourceText()
        delay(300L)
        taps(pointAt("beta"), 2)
        delay(500L)
        assertEquals("marked double tap: sel ${view.selectionStart}-${view.selectionEnd}", "beta", selected())
    }

    @Test
    fun aDoubleTapAfterAFlingSelectsTheWord() = exercise((1..300).joinToString("\n\n") { "Line number $it of a long note" }) {
        view.setSelection(0)
        val down = SystemClock.uptimeMillis()
        val steps = 8
        for (i in 0..steps + 1) {
            val action = when (i) { 0 -> MotionEvent.ACTION_DOWN; steps + 1 -> MotionEvent.ACTION_UP; else -> MotionEvent.ACTION_MOVE }
            val e = MotionEvent.obtain(down, down + i * 16L, action, 100f, 1000f - 400f * i / (steps + 1), 0)
            try { view.dispatchTouchEvent(e) } finally { e.recycle() }
        }
        // Wait out the coast: a touch on a moving note only stops it.
        var last = -1
        withTimeout(20_000) { while (view.scrollY != last || view.scroll.coasting) { last = view.scrollY; delay(250L) } }
        assertTrue("the note scrolled (${view.scrollY})", view.scrollY > 500)
        val layout = view.layout
        val s = view.editableText.toString()
        var visible = layout.getLineForVertical(view.scrollY + view.height / 2)
        while (!s.substring(layout.getLineStart(visible), layout.getLineEnd(visible)).contains("number")) visible++
        val word = "number"
        val offset = s.indexOf(word, layout.getLineStart(visible))
        val x = view.totalPaddingLeft + (layout.getPrimaryHorizontal(offset + 2) + layout.getPrimaryHorizontal(offset + 3)) / 2
        val y = view.totalPaddingTop - view.scrollY + (layout.getLineTop(visible) + layout.getLineBottom(visible)) / 2f
        taps(x to y, 2)
        delay(500L)
        assertEquals("sel ${view.selectionStart}-${view.selectionEnd}", word, selected())
    }

    @Test
    fun aTripleTapSelectsTheLine() = exercise {
        view.setSelection(0)
        taps(pointAt("beta"), 3)
        assertEquals("alpha beta gamma", selected())
        delay(600L)
        taps(pointAt("and www"), 3)
        assertEquals("see https://example.com now and www.example.org too", selected())
    }

    @Test
    fun aTapOnAnExternalLinkOpensItAndPlacesNoCaret() = exercise {
        val opened = mutableListOf<String>()
        view.onOpenUrl = { opened += it }
        view.setSelection(0)
        taps(pointAt("https://example.com"), 1)
        assertEquals(listOf("https://example.com"), opened)
        assertEquals("a link tap leaves the caret alone", 0, view.selectionStart)
        taps(pointAt("www.example.org"), 1)
        assertEquals("http://www.example.org", opened.last())
        taps(pointAt("label"), 1)
        val spans = view.editableText.getSpans(0, view.editableText.length, TfLink::class.java)
            .map { "${view.editableText.getSpanStart(it)}-${view.editableText.getSpanEnd(it)}:${it.destination}" }
        assertEquals("text='$text' links=$spans point=${pointAt("label")}", "https://label.example", opened.last())
        assertEquals(3, opened.size)
    }

    @Test
    fun aTapBesideALinkPlacesTheCaretInstead() = exercise {
        val opened = mutableListOf<String>()
        view.onOpenUrl = { opened += it }
        view.setSelection(0)
        taps(pointAt(" now and"), 1)
        taps(pointAt("end"), 1)
        // The blank space past the end of the link's own line.
        val (_, y) = pointAt("https://example.com")
        taps(view.width - 4f to y, 1)
        assertTrue("only a link's own glyphs open it: $opened", opened.isEmpty())
    }
}
