package com.futo.notes.textfirst

import android.text.Editable
import android.text.Selection
import android.text.Spannable
import android.text.SpanWatcher
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.style.ForegroundColorSpan
import android.text.style.LineBackgroundSpan
import android.text.style.LeadingMarginSpan
import android.text.style.StyleSpan
import android.text.style.UnderlineSpan
import kotlin.random.Random
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Differential test: every edit and span operation runs on [ChunkedEditable]
 * (with tiny chunks, so splits and merges happen constantly) and on a plain
 * SpannableStringBuilder, and every query must agree.
 */
class ChunkedEditableTest {
    @Test fun nativeSelectionMovesDoNotBroadcastShiftedRendererSpans() {
        val source = "line\n".repeat(1_500) + TextFirstEditText.END_SENTINEL
        val text = ChunkedEditable.from(source, target = 40, max = 80)
        repeat(1_500) { line -> text.setSpan(UnderlineSpan(), line * 5, line * 5 + 4, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE) }
        Selection.setSelection(text, source.length - 1)
        val changed = mutableListOf<Any>()
        text.setSpan(object : SpanWatcher {
            override fun onSpanAdded(text: Spannable, what: Any, start: Int, end: Int) = Unit
            override fun onSpanRemoved(text: Spannable, what: Any, start: Int, end: Int) = Unit
            override fun onSpanChanged(text: Spannable, what: Any, oldStart: Int, oldEnd: Int, start: Int, end: Int) {
                changed += what
            }
        }, 0, text.length, Spanned.SPAN_INCLUSIVE_INCLUSIVE)
        text.replace(0, 0, "pack")
        assertEquals(listOf(Selection.SELECTION_START, Selection.SELECTION_END), changed)
        assertEquals(source.length + 3, Selection.getSelectionStart(text))
        assertEquals(1_500, text.getSpans(0, text.length, UnderlineSpan::class.java).size)
    }

    @Test fun typingMovesSelectionSpansWithThePlatformNotifications() {
        fun changes(text: Editable, caret: Int, from: Int, to: Int, value: String, expected: Int): List<String> {
            Selection.setSelection(text, caret)
            val changes = mutableListOf<String>()
            text.setSpan(object : SpanWatcher {
                override fun onSpanAdded(text: Spannable, what: Any, start: Int, end: Int) = Unit
                override fun onSpanRemoved(text: Spannable, what: Any, start: Int, end: Int) = Unit
                override fun onSpanChanged(text: Spannable, what: Any, oldStart: Int, oldEnd: Int, start: Int, end: Int) {
                    val name = when (what) {
                        Selection.SELECTION_START -> "anchor"
                        Selection.SELECTION_END -> "focus"
                        else -> return
                    }
                    changes += "$name $oldStart..$oldEnd -> $start..$end"
                }
            }, 0, text.length, Spanned.SPAN_INCLUSIVE_INCLUSIVE)
            text.replace(from, to, value)
            assertEquals(expected, Selection.getSelectionStart(text))
            assertEquals(expected, Selection.getSelectionEnd(text))
            return changes
        }
        fun compare(source: String, caret: Int, from: Int, to: Int, value: String, expected: Int) {
            val reference = changes(SpannableStringBuilder(source), caret, from, to, value, expected)
            assertEquals("the platform emits only moved selection spans", if (caret == expected) 0 else 2, reference.size)
            assertEquals(reference, changes(ChunkedEditable.from(source, target = 4, max = 8), caret, from, to, value, expected))
        }
        val sentinel = TextFirstEditText.END_SENTINEL
        compare(sentinel, 0, 0, 0, "pack", 4)
        compare("one\ntwo\nthree\n" + sentinel, 13, 0, 0, "pack", 17)
        compare("pack" + sentinel, 4, 0, 4, "", 0)
        compare("one\ntwo\n" + sentinel, 0, 4, 7, "pack", 0)
    }

    private var lastOp = ""
    private var prior: Map<Any, String> = emptyMap()

    private val kinds = listOf(Any::class.java, StyleSpan::class.java, LeadingMarginSpan::class.java, UnderlineSpan::class.java, ForegroundColorSpan::class.java)

    /** LineBackgroundSpan.Standard was added in API 29; this fixture also runs on API 28. */
    private fun lineBackground(color: Int) = LineBackgroundSpan { canvas, paint, left, right, top, _, bottom, _, _, _, _ ->
        val original = paint.color
        paint.color = color
        canvas.drawRect(left.toFloat(), top.toFloat(), right.toFloat(), bottom.toFloat(), paint)
        paint.color = original
    }

    private fun newSpan(random: Random): Any = when (random.nextInt(4)) {
        0 -> StyleSpan(1)
        1 -> LeadingMarginSpan.Standard(4)
        2 -> UnderlineSpan()
        else -> ForegroundColorSpan(random.nextInt())
    }

    private fun lineRange(text: CharSequence, random: Random): Pair<Int, Int> {
        if (text.isEmpty()) return 0 to 0
        val at = random.nextInt(text.length + 1)
        var s = at
        while (s > 0 && text[s - 1] != '\n') s--
        var e = at
        while (e < text.length && text[e] != '\n') e++
        if (e < text.length) e++
        val a = random.nextInt(s, e + 1)
        return a to random.nextInt(a, e + 1)
    }

    private fun check(step: Int, ref: SpannableStringBuilder, sut: ChunkedEditable, spans: List<Any>, random: Random) {
        try { sut.verifyIndex() } catch (e: IllegalStateException) { throw AssertionError("index at step $step after $lastOp: ${e.message}", e) }
        assertEquals("text at step $step", ref.toString(), sut.toString())
        assertEquals(ref.length, sut.length)
        for (span in spans) {
            assertEquals("start of $span at step $step after $lastOp: ${sut.describe(span)} was ${prior[span]} lens=${ref.length}", ref.getSpanStart(span), sut.getSpanStart(span))
            assertEquals("end of $span at step $step", ref.getSpanEnd(span), sut.getSpanEnd(span))
            if (ref.getSpanStart(span) >= 0) assertEquals(ref.getSpanFlags(span), sut.getSpanFlags(span))
        }
        repeat(20) {
            val a = random.nextInt(ref.length + 1)
            val b = if (random.nextBoolean()) a else random.nextInt(a, ref.length + 1)
            val kind = kinds.random(random)
            val want = ref.getSpans(a, b, kind).toSet()
            val got = sut.getSpans(a, b, kind).toSet()
            assertEquals("getSpans($a,$b,${kind.simpleName}) at step $step", want, got)
            val limit = random.nextInt(a, ref.length + 1)
            assertEquals("nextSpanTransition($a,$limit,${kind.simpleName}) at step $step",
                ref.nextSpanTransition(a, limit, kind), sut.nextSpanTransition(a, limit, kind))
        }
        if (ref.isNotEmpty()) {
            val a = random.nextInt(ref.length)
            val b = random.nextInt(a, ref.length + 1)
            val want = CharArray(b - a); ref.getChars(a, b, want, 0)
            val got = CharArray(b - a); sut.getChars(a, b, got, 0)
            assertArrayEquals(want, got)
        }
    }

    @Test
    fun agreesWithSpannableStringBuilder() {
        val words = listOf("alpha ", "beta ", "\n", "gamma\n", "\n\n", "😀", "delta epsilon ")
        val rounds = androidx.test.platform.app.InstrumentationRegistry.getArguments().getString("chunkRounds")?.toInt() ?: 30
        repeat(rounds) { round ->
            val random = Random(1000 + round)
            val initial = buildString { repeat(random.nextInt(0, 400)) { append(words.random(random)) } }
            val ref = SpannableStringBuilder(initial)
            val sut = ChunkedEditable.from(initial, target = 40, max = 80)
            val spans = ArrayList<Any>()
            repeat(300) { step ->
                val op = random.nextInt(10)
                lastOp = "round $round op $op"
                val beforeDesc = spans.associateWith { sut.describe(it) }
                prior = beforeDesc
                when (op) {
                    in 0..3 -> {
                        // Per-line span, as the renderer sets them.
                        val (a, b) = lineRange(ref, random)
                        val span = if (spans.isNotEmpty() && random.nextInt(4) == 0) spans.random(random) else newSpan(random).also { spans += it }
                        // The flags the renderer (exclusive ranges) and TextView (point
                        // carets) use. An inclusive end on a chunk boundary is the one
                        // documented difference: it does not grow with text typed there.
                        val flags = if (a == b) Spanned.SPAN_POINT_POINT else Spanned.SPAN_EXCLUSIVE_EXCLUSIVE
                        ref.setSpan(span, a, b, flags)
                        sut.setSpan(span, a, b, flags)
                    }
                    4 -> if (spans.isNotEmpty()) {
                        val span = spans.random(random)
                        ref.removeSpan(span); sut.removeSpan(span)
                    }
                    5 -> {
                        // A span across lines (the platform may set one).
                        val a = random.nextInt(ref.length + 1)
                        val b = random.nextInt(a, minOf(ref.length, a + 200) + 1)
                        val span = newSpan(random).also { spans += it }
                        ref.setSpan(span, a, b, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                        sut.setSpan(span, a, b, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                    }
                    else -> {
                        val a = random.nextInt(ref.length + 1)
                        val b = if (random.nextInt(3) == 0) random.nextInt(a, minOf(ref.length, a + 120) + 1) else minOf(ref.length, a + random.nextInt(0, 3))
                        val inserted = buildString { repeat(random.nextInt(0, 4)) { append(words.random(random)) } }
                        ref.replace(a, b, inserted)
                        sut.replace(a, b, inserted)
                    }
                }
                check(step, ref, sut, spans, random)
            }
        }
    }

    @Test
    fun splitsLargeTextIntoChunks() {
        val text = (0 until 2000).joinToString("\n") { "line $it" }
        val sut = ChunkedEditable.from(text, target = 500, max = 1000)
        assert(sut.chunkCount > 10) { "expected many chunks, got ${sut.chunkCount}" }
        assertEquals(text, sut.toString())
    }

    @Test
    fun ordersByPriorityOnceAnySpanHasOne() {
        val text = "one\ntwo\nthree\n"
        val ref = SpannableStringBuilder(text)
        val sut = ChunkedEditable.from(text, target = 4, max = 8)
        val low = UnderlineSpan()
        val high = StyleSpan(1)
        val plain = ForegroundColorSpan(1)
        for (t in listOf<Spannable>(ref, sut)) {
            t.setSpan(plain, 0, 3, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            t.setSpan(low, 4, 7, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE or (1 shl Spanned.SPAN_PRIORITY_SHIFT))
            t.setSpan(high, 8, 13, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE or (9 shl Spanned.SPAN_PRIORITY_SHIFT))
        }
        assertEquals(listOf(high, low), sut.getSpans(0, text.length, Any::class.java).take(2))
        assertEquals(ref.getSpans(0, text.length, Any::class.java).take(2), sut.getSpans(0, text.length, Any::class.java).take(2))
        // Removing the prioritized spans returns to unsorted queries with the same members.
        sut.removeSpan(high); sut.removeSpan(low)
        assertArrayEquals(arrayOf<Any>(plain), sut.getSpans(0, text.length, Any::class.java))
    }

    @Test
    fun drawWindowClampsOnlyLineBackgroundQueries() {
        val text = "a\nb\nc\nd\n"
        val sut = ChunkedEditable.from(text, target = 2, max = 4)
        val near = lineBackground(1)
        val far = lineBackground(2)
        val other = UnderlineSpan()
        sut.setSpan(near, 0, 1, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        sut.setSpan(far, 6, 7, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        sut.setSpan(other, 6, 7, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        sut.drawWindow = 0..2
        assertEquals(setOf(near), sut.getSpans(0, text.length, LineBackgroundSpan::class.java).toSet())
        assertEquals(setOf(other), sut.getSpans(0, text.length, UnderlineSpan::class.java).toSet())
        sut.drawWindow = null
        assertEquals(setOf(near, far), sut.getSpans(0, text.length, LineBackgroundSpan::class.java).toSet())
    }
}
