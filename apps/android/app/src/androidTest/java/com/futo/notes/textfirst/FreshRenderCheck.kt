package com.futo.notes.textfirst

import kotlin.coroutines.resume
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import org.junit.Assert.assertEquals

/**
 * As the view keeps a span, as a fresh open would make it: a table row whose table moved keeps its identity key
 * (tableStart) and draws shifted, every cell where it was; a code line has the number, place and block facts a fresh
 * open gives it (not the block's offsets, which drawing reads from the spans).
 */
private fun drawnAlike(c: TextFirstController, spec: SpanSpec, span: TfSpan): Boolean {
    if (spec is SpanSpec.Code && span is TfCodeBlock) {
        val (old, next) = span.line to spec.line
        return old.number == next.number && old.first == next.first && old.last == next.last &&
            old.block.language == next.block.language && old.block.name == next.block.name && old.block.lineCount == next.block.lineCount
    }
    if (spec !is SpanSpec.TableRow || span !is TfTableRow) return c.view.spans.matches(spec, span)
    val shift = spec.start - span.displayStart
    val (old, next) = span.row to spec.row
    return old.header == next.header && old.columns == next.columns && old.cells.size == next.cells.size &&
        old.cells.indices.all {
            old.cells[it].start + shift == next.cells[it].start && old.cells[it].end + shift == next.cells[it].end &&
                old.cells[it].text == next.cells[it].text && old.cells[it].alignment == next.cells[it].alignment
        }
}

/**
 * The live view's renderer spans against the engine's style plan of the whole note, which is what a fresh open lays
 * out: every row restyled after an edit, none left with the spans of the text that stood there before. Each mismatch
 * is "missing" (planned, not in the view) or "stale" (in the view, not planned), with its class, range and text; a
 * span set with other flags than the view gives it ("flags"), and a photo back to its placeholder ("unloaded").
 */
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
        for (span in e.getSpans(0, e.length, TfSpan::class.java)) {
            val (s, en) = e.getSpanStart(span) to e.getSpanEnd(span)
            if (s >= 0 && e.getSpanFlags(span) != rendererSpanFlags(e, span, s, en)) out += "flags ${span::class.simpleName} ${at(s, en)}"
            if (span is TfImage && span.bitmap == null && !span.failed) out += "unloaded ${span.destination} ${at(s, en)}"
        }
        out
    }
    assertEquals("$what: the view's spans against a fresh plan", emptyList<String>(), mismatches)
}
