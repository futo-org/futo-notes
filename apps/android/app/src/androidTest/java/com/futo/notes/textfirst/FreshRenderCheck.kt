package com.futo.notes.textfirst

import kotlin.coroutines.resume
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import org.junit.Assert.assertEquals

/**
 * The live view's renderer spans against the engine's style plan of the whole note, which is what a fresh open lays
 * out: every row restyled after an edit, none left with the spans of the text that stood there before. Each mismatch
 * is "missing" (planned, not in the view) or "stale" (in the view, not planned), with its class, range and text.
 */
/** As the view keeps a span: a table row whose table moved keeps its identity key (tableStart) and draws shifted. */
private fun drawnAlike(c: TextFirstController, spec: SpanSpec, span: TfSpan): Boolean {
    if (spec !is SpanSpec.TableRow || span !is TfTableRow) return c.view.spans.matches(spec, span)
    val shift = spec.start - span.displayStart
    val (old, next) = span.row to spec.row
    return old.header == next.header && old.columns == next.columns && old.cells.size == next.cells.size &&
        old.cells.indices.all { old.cells[it].start + shift == next.cells[it].start && old.cells[it].text == next.cells[it].text && old.cells[it].alignment == next.cells[it].alignment }
}

internal suspend fun assertRendersAsFresh(c: TextFirstController, what: String) {
    delay(400)
    val engine = checkNotNull(c.view.engine)
    val plan = suspendCancellableCoroutine<StyleWindow> { done -> engine.handler.post { done.resume(engine.planStyleWindow(0, engine.mirror.text.length)) } }
    val mismatches = withContext(Dispatchers.Main) {
        val e = c.view.editableText
        val text = e.toString()
        fun at(s: Int, en: Int) = "[$s,$en) \"${text.substring(s, minOf(en, text.length)).replace("\n", "⏎").take(30)}\""
        val live = e.getSpans(0, e.length, TfSpan::class.java).filter { e.getSpanStart(it) >= 0 }.toMutableList()
        val out = mutableListOf<String>()
        for (spec in plan.specs) {
            val end = if (spec.start == spec.end && spec.start == e.length - 1) spec.end + 1 else spec.end
            val match = live.indexOfFirst { e.getSpanStart(it) == spec.start && (e.getSpanEnd(it) == end || spec.start == spec.end && e.getSpanEnd(it) == spec.start + 1) && drawnAlike(c, spec, it) }
            if (match >= 0) live.removeAt(match) else out += "missing ${spec::class.simpleName}${(spec as? SpanSpec.ListRow)?.let { " first=${it.first} checked=${it.checked}" } ?: ""} ${at(spec.start, end)}"
        }
        for (span in live) out += "stale ${span::class.simpleName}${(span as? TfList)?.let { " first=${it.first} checked=${it.checked}" } ?: ""} ${at(e.getSpanStart(span), e.getSpanEnd(span))}"
        out
    }
    assertEquals("$what: the view's spans against a fresh plan", emptyList<String>(), mismatches)
}
