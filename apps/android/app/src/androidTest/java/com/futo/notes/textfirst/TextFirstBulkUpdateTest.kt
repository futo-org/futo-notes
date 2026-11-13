package com.futo.notes.textfirst

import android.os.SystemClock
import android.text.Editable
import android.text.Selection
import android.text.SpanWatcher
import android.text.Spannable
import android.text.Spanned
import android.text.TextWatcher
import android.text.style.UnderlineSpan
import androidx.activity.ComponentActivity
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.util.UUID
import org.junit.Assert.*
import org.junit.Test

/** The attached renderer must publish final text and styles together, rather than one reflow per span. */
class TextFirstBulkUpdateTest {
    @Test fun aCellEditCannotHideAStyleChangeInAnotherTableRow() = exercise {
        val left = uniffi.futo_notes_ffi.EditorTableAlignment.LEFT
        val right = uniffi.futo_notes_ffi.EditorTableAlignment.RIGHT
        fun rows(edited: Boolean): List<SpanSpec> {
            val first = if (edited) "fixrst" else "first"
            val tail = 10 + first.length + 1
            fun row(start: Int, text: String, header: Boolean = false,
                    alignment: uniffi.futo_notes_ffi.EditorTableAlignment = left) =
                SpanSpec.TableRow(start, start + text.length + 1,
                    GridRow(listOf(GridCell(start, start + text.length, text, alignment)), 1, header, 0))
            return listOf(row(0, "head", true), SpanSpec.TableDelimiter(5, 10),
                row(10, first), row(tail, "last", alignment = if (edited) right else left))
        }
        val source = "head\n----\nfirst\nlast\n"
        view.apply(UiUpdate(2, source, emptyList(), 12, 12, -1, -1,
            listOf(StyleWindow(0, source.length, rows(false))), 0L))
        val watcher = observe()
        view.apply(UiUpdate(3, null, listOf(TextEdit(12, 12, "x")), 13, 13, -1, -1,
            listOf(StyleWindow(0, source.length + 1, rows(true))), 0L))
        assertEquals(source.replace("first", "fixrst") + TextFirstEditText.END_SENTINEL, view.text.toString())
        assertEquals(listOf(Triple(0, source.length + 1, source.length + 2)), watcher.changed)
        val last = view.editableText.getSpans(17, 21, TfTableRow::class.java).single()
        assertEquals(right, last.row.cells.single().alignment)
    }

    @Test fun implicitSelectionMovesFollowFinalRendererCallbacksInWatcherPriorityOrder() = exercise {
        Selection.setSelection(view.editableText, 4)
        val source = "packold\n"
        val events = mutableListOf<String>()
        fun watch(name: String, priority: Int) {
            val watcher = object : TextWatcher, SpanWatcher {
                override fun beforeTextChanged(s: CharSequence, start: Int, count: Int, after: Int) { events += "$name before" }
                override fun onTextChanged(s: CharSequence, start: Int, before: Int, count: Int) { events += "$name changed" }
                override fun afterTextChanged(s: Editable) { events += "$name after" }
                override fun onSpanAdded(text: Spannable, what: Any, start: Int, end: Int) = Unit
                override fun onSpanRemoved(text: Spannable, what: Any, start: Int, end: Int) = Unit
                override fun onSpanChanged(text: Spannable, what: Any, oldStart: Int, oldEnd: Int, start: Int, end: Int) {
                    val token = when (what) {
                        Selection.SELECTION_START -> "anchor"
                        Selection.SELECTION_END -> "focus"
                        else -> return
                    }
                    assertEquals(source + TextFirstEditText.END_SENTINEL, text.toString())
                    assertTrue(text.getSpans(0, 4, TfInline::class.java).single().bold)
                    events += "$name $token"
                }
            }
            view.editableText.setSpan(watcher, 0, view.length(), Spanned.SPAN_INCLUSIVE_INCLUSIVE or
                (priority shl Spanned.SPAN_PRIORITY_SHIFT))
        }
        watch("low", 1)
        watch("high", 9)
        view.apply(update(2, listOf(TextEdit(0, 0, "pa"), TextEdit(2, 2, "ck")),
            listOf(SpanSpec.Inline(0, 4, true, false, false, false)), source.length, 8, 8))
        assertEquals(listOf("high before", "low before", "high changed", "low changed", "high after", "low after",
            "high anchor", "low anchor", "high focus", "low focus"), events)
    }

    @Test fun bulkTextAndStylesPublishOneFinalChangeInsteadOfPerSpanNotifications() = exercise {
        val source = lines(256)
        val watcher = observe()
        view.apply(update(2, listOf(TextEdit(0, 4, source)), specs(source, bold = true), source.length, 3, 5))
        assertEquals(source + TextFirstEditText.END_SENTINEL, view.text.toString())
        assertEquals(256, view.editableText.getSpans(0, view.length(), TfInline::class.java).size)
        assertEquals("renderer spans must not each notify DynamicLayout", 0, watcher.rendererEvents)
        assertEquals(listOf(Triple(0, 5, source.length + 1)), watcher.before)
        assertEquals(listOf(Triple(0, 5, source.length + 1)), watcher.changed)
        assertEquals("the change observer sees all final styles", listOf(256), watcher.styledAtChange)
        assertEquals(1, watcher.after)
        assertEquals(source + TextFirstEditText.END_SENTINEL, watcher.textAtChange.single())
    }

    @Test fun styleOnlyUpdatesPublishTheirFinalRangeOnce() = exercise {
        val source = lines(256)
        view.apply(update(2, listOf(TextEdit(0, 4, source)), specs(source, bold = true), source.length, 3, 5))
        val watcher = observe()
        view.apply(update(3, emptyList(), specs(source, bold = false), source.length, 3, 5))
        val rendered = view.editableText.getSpans(0, view.length(), TfInline::class.java)
        assertEquals(256, rendered.size)
        assertTrue(rendered.all { !it.bold && it.italic })
        assertEquals(0, watcher.rendererEvents)
        assertEquals(listOf(Triple(0, source.length + 1, source.length + 1)), watcher.changed)
        assertEquals(listOf(256), watcher.styledAtChange)
    }

    @Test fun rendererUpdatesPreserveNativeSelectionAndCompositionNotifications() = exercise {
        val watcher = observe()
        val source = lines(8)
        view.apply(update(2, listOf(TextEdit(0, 4, source)), specs(source, bold = true), source.length, 3, 5))
        assertEquals(3, view.selectionStart)
        assertEquals(5, view.selectionEnd)
        assertTrue("selection start remains observable", watcher.selectionStartEvents > 0)
        assertTrue("selection end remains observable", watcher.selectionEndEvents > 0)
        assertTrue("composition remains observable", watcher.compositionEvents > 0)
        val composing = view.editableText.getSpans(0, 4, UnderlineSpan::class.java)
            .filter { view.editableText.getSpanFlags(it) and Spanned.SPAN_COMPOSING != 0 }
        assertEquals(1, composing.size)
        assertEquals(0, view.editableText.getSpanStart(composing.single()))
        assertEquals(4, view.editableText.getSpanEnd(composing.single()))
    }

    @Test fun aBeforeWatcherFailureDoesNotPublishAnUnstartedChangeOrMaskTheError() = exercise {
        val first = IllegalStateException("before watcher")
        val second = IllegalArgumentException("unstarted change watcher")
        val failing = observe(Watcher(failBefore = first))
        val later = observe(Watcher(failChanged = second))
        val source = lines(8)
        val thrown = assertThrows(IllegalStateException::class.java) {
            view.apply(update(2, listOf(TextEdit(0, 4, source)), specs(source, true), source.length, 3, 5))
        }
        assertSame(first, thrown)
        assertEquals("old\n" + TextFirstEditText.END_SENTINEL, view.text.toString())
        assertTrue(failing.changed.isEmpty())
        assertTrue(later.changed.isEmpty())
        assertEquals(0, later.after)
        view.editableText.removeSpan(failing)
        view.editableText.removeSpan(later)
        view.apply(update(3, listOf(TextEdit(0, 4, source)), specs(source, true), source.length, 3, 5))
        assertEquals(source + TextFirstEditText.END_SENTINEL, view.text.toString())
    }

    @Test fun aCompletionWatcherFailureStillFinishesOtherNativeObservers() = exercise {
        Selection.setSelection(view.editableText, 4)
        val first = IllegalStateException("change watcher")
        val second = IllegalArgumentException("selection watcher")
        val failing = observe(Watcher(failChanged = first))
        val selectionFailure = observe(Watcher(failSelection = second))
        val later = observe()
        val source = lines(8)
        val thrown = assertThrows(IllegalStateException::class.java) {
            view.apply(update(2, listOf(TextEdit(0, 4, source)), specs(source, true), source.length, 3, 5))
        }
        assertSame(first, thrown)
        assertEquals(1, failing.after)
        assertEquals(1, selectionFailure.after)
        assertEquals(1, later.after)
        assertEquals(listOf(8), later.styledAtChange)
        assertTrue(first.suppressed.contains(second))
        assertTrue(later.selectionStartEvents > 0)
        assertTrue(later.selectionEndEvents > 0)
    }

    @Test fun aPartialRendererFailureStaysPrimaryWhileLayoutObserversFinish() = exercise {
        val first = IllegalStateException("render edit")
        val second = IllegalArgumentException("change observer")
        val failing = observe(Watcher(failChanged = second))
        val later = observe()
        view.filters = view.filters + android.text.InputFilter { source, _, _, _, _, _ ->
            if (source.toString() == "boom") throw first else null
        }
        val thrown = assertThrows(IllegalStateException::class.java) {
            view.apply(update(2, listOf(TextEdit(0, 4, "valid\n"), TextEdit(0, 1, "boom")), emptyList(), 9, 0, 0))
        }
        assertSame(first, thrown)
        assertTrue(first.suppressed.contains(second))
        assertEquals("valid\n" + TextFirstEditText.END_SENTINEL, view.text.toString())
        assertEquals(1, failing.after)
        assertEquals(1, later.after)
    }

    @Test fun styleMetadataPastTheVisiblePrefixKeepsItsApplicableSpansWithoutCrashing() = exercise {
        val watcher = observe()
        view.apply(update(2, emptyList(), listOf(
            SpanSpec.Inline(0, 2, true, false, false, false),
            SpanSpec.Inline(5_000, 5_010, true, false, false, false),
        ), 10_000, 0, 0))
        assertEquals("old\n" + TextFirstEditText.END_SENTINEL, view.text.toString())
        assertEquals(1, view.editableText.getSpans(0, view.length(), TfInline::class.java).size)
        assertEquals(listOf(Triple(0, 5, 5)), watcher.changed)
    }

    @Test fun rendererBatchRetainsNativeTextWatcherPriorityOrder() = exercise {
        val calls = mutableListOf<String>()
        fun watcher(label: String) = object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence, start: Int, count: Int, after: Int) { calls += "before $label" }
            override fun onTextChanged(s: CharSequence, start: Int, before: Int, count: Int) { calls += "changed $label" }
            override fun afterTextChanged(s: Editable) { calls += "after $label" }
        }
        val e = view.editableText
        e.setSpan(watcher("low"), 0, e.length, Spanned.SPAN_INCLUSIVE_INCLUSIVE)
        e.setSpan(watcher("high"), 0, e.length, Spanned.SPAN_INCLUSIVE_INCLUSIVE or (200 shl Spanned.SPAN_PRIORITY_SHIFT))
        view.apply(update(2, emptyList(), specs("old\n", true), 4, 0, 0))
        assertEquals(listOf("before high", "before low", "changed high", "changed low", "after high", "after low"), calls)
    }

    @Test fun boundedHeadingRestyleDoesNotMeasureTheUnchangedTail() = exercise {
        val source = lines(4_000)
        view.apply(UiUpdate(2, source, emptyList(), 0, 0, -1, -1, emptyList(), 0L))
        val exact = android.view.View.MeasureSpec.EXACTLY
        view.measure(android.view.View.MeasureSpec.makeMeasureSpec(800, exact), android.view.View.MeasureSpec.makeMeasureSpec(600, exact))
        view.layout(0, 0, 800, 600)
        var tailMeasures = 0
        val counter = object : android.text.style.MetricAffectingSpan() {
            override fun updateMeasureState(paint: android.text.TextPaint) { tailMeasures++ }
            override fun updateDrawState(paint: android.text.TextPaint) = Unit
        }
        val tail = source.lastIndexOf("line 3999")
        view.editableText.setSpan(counter, tail, tail + 9, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        tailMeasures = 0
        val windowEnd = source.indexOf('\n', 6_000) + 1
        val headings = mutableListOf<SpanSpec>()
        var from = 0
        while (from < windowEnd) {
            val to = source.indexOf('\n', from) + 1
            headings += SpanSpec.Heading(from, to, 1)
            from = to
        }
        view.apply(UiUpdate(3, null, listOf(TextEdit(source.length, source.length, "")), 0, source.length, -1, -1,
            listOf(StyleWindow(0, windowEnd, headings)), SystemClock.elapsedRealtimeNanos()))
        assertEquals("a 6k renderer window must not remeasure a distant unchanged row", 0, tailMeasures)
        assertEquals(source + TextFirstEditText.END_SENTINEL, view.text.toString())
    }

    private class Watcher(val failBefore: Throwable? = null, val failChanged: Throwable? = null, val failSelection: Throwable? = null) : TextWatcher, SpanWatcher {
        val before = mutableListOf<Triple<Int, Int, Int>>()
        val changed = mutableListOf<Triple<Int, Int, Int>>()
        val styledAtChange = mutableListOf<Int>()
        val textAtChange = mutableListOf<String>()
        var after = 0
        var rendererEvents = 0
        var selectionStartEvents = 0
        var selectionEndEvents = 0
        var compositionEvents = 0
        override fun beforeTextChanged(s: CharSequence, start: Int, count: Int, after: Int) { before += Triple(start, count, after); failBefore?.let { throw it } }
        override fun onTextChanged(s: CharSequence, start: Int, before: Int, count: Int) {
            changed += Triple(start, before, count)
            styledAtChange += (s as Spanned).getSpans(0, s.length, TfInline::class.java).size
            textAtChange += s.toString()
            failChanged?.let { throw it }
        }
        override fun afterTextChanged(s: Editable) { after++ }
        private fun event(text: Spannable, what: Any) {
            if (what is TfSpan) rendererEvents++
            if (what === Selection.SELECTION_START) selectionStartEvents++
            if (what === Selection.SELECTION_END) selectionEndEvents++
            if (what === Selection.SELECTION_START || what === Selection.SELECTION_END) failSelection?.let { throw it }
            if (text.getSpanFlags(what) and Spanned.SPAN_COMPOSING != 0) compositionEvents++
        }
        override fun onSpanAdded(text: Spannable, what: Any, start: Int, end: Int) = event(text, what)
        override fun onSpanRemoved(text: Spannable, what: Any, start: Int, end: Int) = event(text, what)
        override fun onSpanChanged(text: Spannable, what: Any, oldStart: Int, oldEnd: Int, start: Int, end: Int) = event(text, what)
    }

    private class Rig(val view: TextFirstEditText) {
        fun observe(watcher: Watcher = Watcher()) = watcher.also { view.editableText.setSpan(it, 0, view.length(), Spanned.SPAN_INCLUSIVE_INCLUSIVE) }
        fun lines(count: Int) = (0 until count).joinToString("") { "line $it\n" }
        fun specs(source: String, bold: Boolean): List<SpanSpec> {
            var start = 0
            return source.splitToSequence('\n').filter { it.isNotEmpty() }.map { line ->
                SpanSpec.Inline(start, start + line.length, bold, !bold, false, false).also { start += line.length + 1 }
            }.toList()
        }
        fun update(seq: Int, edits: List<TextEdit>, specs: List<SpanSpec>, length: Int, start: Int, end: Int) = UiUpdate(
            seq, null, edits, start, end, 0, 4, listOf(StyleWindow(0, length, specs)), SystemClock.elapsedRealtimeNanos(),
        )
    }

    private fun exercise(check: Rig.() -> Unit) {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val root = File(context.cacheDir, "bulk-update-${UUID.randomUUID()}").apply { check(mkdirs()) }
        val scenario = ActivityScenario.launch(ComponentActivity::class.java)
        lateinit var controller: TextFirstController
        try {
            scenario.onActivity { activity ->
                controller = createTextFirstController(activity, { error("renderer-only fixture has no engine") }, root)
                activity.setContentView(controller.view)
                controller.view.apply(UiUpdate(1, "old\n", emptyList(), 0, 0, -1, -1, emptyList(), 0L))
                Rig(controller.view).check()
            }
        } finally {
            scenario.onActivity { controller.dispose() }
            scenario.close()
            root.deleteRecursively()
        }
    }
}
