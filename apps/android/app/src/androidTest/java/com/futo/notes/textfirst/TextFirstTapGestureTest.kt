package com.futo.notes.textfirst

import android.os.SystemClock
import android.view.ActionMode
import android.view.Menu
import android.view.MenuItem
import android.view.InputDevice
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

    @Test
    fun exactSelectionStillUsesThePlatformClassificationForSmartActions() {
        val classification = android.view.textclassifier.TextClassification.Builder().setText("https://example.com").build()
        var calls = 0
        val native = object : android.view.textclassifier.TextClassifier {
            override fun classifyText(request: android.view.textclassifier.TextClassification.Request): android.view.textclassifier.TextClassification {
                calls++
                return classification
            }
            override fun suggestSelection(request: android.view.textclassifier.TextSelection.Request): android.view.textclassifier.TextSelection = error("a delayed platform suggestion must not expand this range")
        }
        val classifier = selectionTextClassifier(native)
        val text = "see https://example.com now"
        assertSame(classification, classifier.classifyText(android.view.textclassifier.TextClassification.Request.Builder(text, 4, 23).build()))
        assertEquals(1, calls)
        val selection = classifier.suggestSelection(android.view.textclassifier.TextSelection.Request.Builder(text, 4, 7).build())
        assertEquals(4, selection.selectionStartIndex)
        assertEquals(7, selection.selectionEndIndex)
    }

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
        suspend fun taps(
            point: Pair<Float, Float>,
            count: Int,
            drift: FloatArray = floatArrayOf(),
            duration: Long = 40L,
            afterDown: (tap: Int) -> Unit = {},
        ) {
            clock = maxOf(clock + 1_000L, SystemClock.uptimeMillis())
            repeat(count) {
                val down = clock
                val path = listOf(MotionEvent.ACTION_DOWN to 0f) + drift.dropLast(1).map { MotionEvent.ACTION_MOVE to it } +
                    (MotionEvent.ACTION_UP to (drift.lastOrNull() ?: 0f))
                path.forEachIndexed { step, (action, dx) ->
                    val e = MotionEvent.obtain(down, down + duration * step / path.lastIndex, action, point.first + dx, point.second, 0)
                    e.source = InputDevice.SOURCE_TOUCHSCREEN
                    try { view.dispatchTouchEvent(e) } finally { e.recycle() }
                    if (action == MotionEvent.ACTION_DOWN) afterDown(it)
                }
                clock += 100L
            }
            controller.sourceText()
        }

        fun selected() = text.substring(view.selectionStart, view.selectionEnd)
    }

    @Test fun checkboxTapsStayWithinTheLiveRow() = exercise("") {
        val raw = "- [ ] Pack"
        val input = view.onCreateInputConnection(android.view.inputmethod.EditorInfo())!!
        for (ch in raw) {
            textFirstIme(controller, connection = input) { commitText(ch.toString(), 1) }
            controller.sourceText()
        }
        assertEquals(raw, controller.sourceText())
        assertEquals("Pack" + TextFirstEditText.END_SENTINEL, text)
        withTimeout(5_000) { while (view.layout.getLineEnd(0) != view.length()) delay(20) }
        val l = view.layout
        val top = view.totalPaddingTop
        val edge = view.totalPaddingLeft + l.getParagraphLeft(0)
        val x = edge - view.style.listIndent / 2
        val rowY = top + l.height / 2f
        val below = top + l.height + view.style.dp(150f)
        assertTrue(below < view.height)
        taps(x to below, 1)
        assertEquals("below row", raw, controller.sourceText())
        taps(x to top - 1f, 1)
        assertEquals("top padding", raw, controller.sourceText())
        taps(edge + 1f to rowY, 1)
        assertEquals(raw, controller.sourceText())
        taps(x to rowY, 1)
        assertEquals("- [x] Pack", controller.sourceText())
        controller.undo()
        assertEquals(raw, controller.sourceText())
        controller.select(4)
        textFirstIme(controller, connection = input) { commitText(" parcel".repeat(20), 1) }
        val wrapped = controller.sourceText()
        withTimeout(5_000) { while (view.layout.lineCount < 2) delay(20) }
        val nextY = top + (view.layout.getLineTop(1) + view.layout.getLineBottom(1)) / 2f
        taps(x to nextY, 1)
        assertEquals("wrapped continuation", wrapped, controller.sourceText())
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

    /**
     * Samsung's One UI 8.5 (Android 16) text view placed a caret on a double-tap and selected
     * nothing, where AOSP selects the word on the second touch-down. Model that phone by taking
     * the platform's selection away as soon as the second tap lands: the word is still selected.
     */
    @Test
    fun aDoubleTapSelectsTheWordWhenThePlatformSelectsNothing() = exercise {
        view.setSelection(0)
        val caret = text.indexOf("beta") + 2
        taps(pointAt("beta"), 2, afterDown = { tap -> if (tap == 1) view.setSelection(caret) })
        delay(500L)
        assertEquals("platform without word select: sel ${view.selectionStart}-${view.selectionEnd}", "beta", selected())
    }

    /** The same phone's selection can also collapse a moment after the second tap lifts. */
    @Test
    fun aDoubleTapKeepsTheWordWhenThePlatformCollapsesItLater() = exercise {
        view.setSelection(0)
        val caret = text.indexOf("beta") + 2
        taps(pointAt("beta"), 2)
        view.setSelection(caret)
        delay(800L)
        assertEquals("late collapse: sel ${view.selectionStart}-${view.selectionEnd}", "beta", selected())
    }

    /** A double-tap on the space between two words selects nothing of its own making. */
    @Test
    fun aDoubleTapOnBlankSpaceAddsNoWordSelection() = exercise {
        view.setSelection(0)
        val (x, y) = pointAt("alpha beta", 5)
        taps(x to y, 2, afterDown = { tap -> if (tap == 1) view.setSelection(5) })
        delay(800L)
        assertEquals("blank double tap: sel ${view.selectionStart}-${view.selectionEnd}", "", selected())
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
            e.source = InputDevice.SOURCE_TOUCHSCREEN
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
    fun repeatedTripleTapsKeepTheNativeSelectionCallout() = exercise { assertTripleTapCallout("beta", "alpha beta gamma") }

    @Test
    fun aTripleTapOnASingleWordLineStartsNativeSelectionMode() = exercise("solo") { assertTripleTapCallout("solo", "solo") }

    private suspend fun Rig.assertTripleTapCallout(word: String, line: String) {
        var selectionMode: ActionMode? = null
        view.customSelectionActionModeCallback = object : ActionMode.Callback {
            override fun onCreateActionMode(mode: ActionMode, menu: Menu): Boolean {
                selectionMode = mode
                return true
            }
            override fun onPrepareActionMode(mode: ActionMode, menu: Menu) = false
            override fun onActionItemClicked(mode: ActionMode, item: MenuItem) = false
            override fun onDestroyActionMode(mode: ActionMode) { if (selectionMode === mode) selectionMode = null }
        }
        repeat(4) { sequence ->
            taps(pointAt(word), 3)
            withTimeout(5_000) { while (selectionMode == null) delay(20) }
            assertEquals("triple tap $sequence keeps the line after native selection mode starts", line, selected())
        }
    }

    @Test
    fun aTapOnEachWrappedLineOfALinkOpensItAndPlacesNoCaret() {
        for ((first, last) in listOf("alpha" to "omega", "🧑‍🧒alpha" to "βeta", "אבגד" to "הוזח")) {
            assertBothLinkEndsOpen("before [$first ${"wrap ".repeat(20)}$last](https://example.com) after\n", first, last)
        }
    }

    @Test
    fun aTapOnAnUnbrokenWrappedLinkOpensItAndPlacesNoCaret() =
        assertBothLinkEndsOpen("before [alpha${"x".repeat(120)}omega](https://example.com) after\n", "alpha", "omega")

    @Test
    fun aLongPressOrDragOnAnExternalLinkDoesNotOpenIt() = exercise("before [alpha beta gamma](https://example.com) after\n") {
        val opened = mutableListOf<String>()
        view.onOpenUrl = { opened += it; true }
        taps(pointAt("alpha"), 1, duration = android.view.ViewConfiguration.getLongPressTimeout() + 1L)
        val slop = android.view.ViewConfiguration.get(view.context).scaledTouchSlop.toFloat()
        taps(pointAt("alpha"), 1, drift = floatArrayOf(slop + 1f, slop + 2f))
        assertTrue("holding or dragging external-link glyphs stays text interaction", opened.isEmpty())
    }

    private fun assertBothLinkEndsOpen(source: String, first: String, last: String) = exercise(source) {
        assertEquals("the authored fixture already has its canonical final newline", source, controller.sourceText())
        val opened = mutableListOf<String>()
        view.onOpenUrl = { opened += it; true }
        assertTrue("the link has separate first and last visual lines",
            view.layout.getLineForOffset(text.indexOf(first)) < view.layout.getLineForOffset(text.indexOf(last)))
        val caret = text.indexOf("after")
        for (focused in listOf(true, false)) {
            if (focused) view.requestFocus() else view.clearFocus()
            view.setSelection(caret)
            // The last segment is the control: each segment of the same canonical link opens it.
            for (word in listOf(last, first)) {
                val calls = opened.size
                taps(pointAt(word), 1)
                val links = view.editableText.getSpans(0, view.editableText.length, TfLink::class.java)
                    .map { "${view.editableText.getSpanStart(it)}..${view.editableText.getSpanEnd(it)}" }
                val line = view.layout.getLineForOffset(text.indexOf(word))
                assertEquals("$word focused=$focused links=$links line=$line end=${view.layout.getLineEnd(line)} visible=${view.layout.getLineVisibleEnd(line)} point=${pointAt(word)}", calls + 1, opened.size)
                assertEquals("https://example.com", opened.last())
                assertEquals("$word leaves the caret start", caret, view.selectionStart)
                assertEquals("$word leaves the caret end", caret, view.selectionEnd)
                assertEquals("$word leaves focus", focused, view.isFocused)
            }
        }
        val calls = opened.size
        taps(pointAt("before"), 1)
        val (_, y) = pointAt(first)
        taps(view.width - 4f to y, 1)
        assertEquals("the prefix and blank tail are outside the linked glyphs", calls, opened.size)
        assertEquals(source, controller.sourceText())
    }

    @Test
    fun aTapOnAnExternalLinkOpensItAndPlacesNoCaret() = exercise {
        val opened = mutableListOf<String>()
        view.onOpenUrl = { opened += it; true }
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
        view.onOpenUrl = { opened += it; true }
        view.setSelection(0)
        taps(pointAt(" now and"), 1)
        taps(pointAt("end"), 1)
        // The blank space past the end of the link's own line.
        val (_, y) = pointAt("https://example.com")
        taps(view.width - 4f to y, 1)
        assertTrue("only a link's own glyphs open it: $opened", opened.isEmpty())
    }

    @Test
    fun aLinkTheSystemCannotOpenIsATapOnTextAndPlacesTheCaret() = exercise {
        val offered = mutableListOf<String>()
        view.onOpenUrl = { offered += it; false }
        view.setSelection(0)
        val link = text.indexOf("https://example.com")
        taps(pointAt("https://example.com"), 1)
        assertEquals(listOf("https://example.com"), offered)
        assertTrue("a refused open leaves the tap to the caret: ${view.selectionStart}", view.selectionStart in link until link + "https://example.com".length)
    }
}
