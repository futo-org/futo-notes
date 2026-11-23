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

/** Real taps on external links in the note: a tap opens the link and places no caret; a hold or a drag does not. */
class TextFirstLinkTapGestureTest {
    private val source = TAP_GESTURE_NOTE

    private fun exercise(source: String = this.source, check: suspend TapGestureRig.() -> Unit) = tapGestureSession(source, check)

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
