package com.futo.notes.textfirst

import android.graphics.Canvas
import android.graphics.Paint
import android.text.Layout
import android.text.Spanned

/**
 * A selection near code, as !300 painted it (cb 110-130, 389-433): resolved by
 * [resolveCodeSelection], a block taken whole painted as its card, every other row bounded by the
 * text it covers and kept off the header and the skirt. The TextView's own highlight is hidden
 * meanwhile. The native selection is never rewritten, so its handles stay under the finger; the
 * engine is sent the resolved range, so every action takes what is painted.
 */
internal class CodeSelectionPaint(
    /** The resolved range, start first. */
    val start: Int,
    val end: Int,
    /** The block whose code holds the anchor, or null when blocks are taken whole. */
    val home: CodeRange?,
)

/** The code blocks with spans in [from, to], from their spans where shown and their facts beyond. */
internal fun codeRangesNear(e: Spanned, from: Int, to: Int): List<CodeRange> {
    val spans = e.getSpans(maxOf(0, from - 1), minOf(e.length, to + 1), TfCodeBlock::class.java)
    if (spans.isEmpty()) return emptyList()
    spans.sortBy { e.getSpanStart(it) }
    val ranges = ArrayList<CodeRange>()
    var at = 0
    while (at < spans.size) {
        var last = at
        while (last + 1 < spans.size && continuesCard(e, spans[last], spans[last + 1])) last++
        val head = spans[at]
        val tail = spans[last]
        val start = if (head.line.first) e.getSpanStart(head) else head.line.block.start
        val end = if (tail.line.last) codeLineEnd(e, tail) else tail.line.block.end
        ranges.add(CodeRange(start, end))
        at = last + 1
    }
    return ranges
}

/** Where a code line's text ends: its span's end without its line break or the note's end sentinel. */
internal fun codeLineEnd(e: Spanned, span: TfCodeBlock): Int {
    var end = minOf(e.getSpanEnd(span), e.length - TextFirstEditText.END_SENTINEL.length)
    if (end > e.getSpanStart(span) && e[end - 1] == '\n') end--
    return end
}

/** What [anchor] to [head] paints, or null when no block is near it (the TextView paints it). */
internal fun TextFirstEditText.codeSelectionFor(anchor: Int, head: Int): CodeSelectionPaint? {
    val e = editableText ?: return null
    if (anchor < 0 || head < 0) return null
    val blocks = codeRangesNear(e, minOf(anchor, head), maxOf(anchor, head))
    if (blocks.isEmpty()) return null
    val (start, end) = resolveCodeSelection(anchor, head, blocks)
    // A block selected as one object is painted as its card alone.
    if (selectedCodeBlock == (start to end)) return null
    val home = blocks.firstOrNull { it.start < it.end && anchor >= it.start && anchor <= it.end }
    if (home == null && blocks.none { start <= it.start && end >= it.end }) return null
    return CodeSelectionPaint(start, end, home)
}

internal val TextFirstEditText.codeSelection: CodeSelectionPaint? get() = codeChrome.selection

/** Repaint for the view's new selection, [start] to [end] as it reports them; returns what is painted, null when the TextView paints it. */
internal fun TextFirstEditText.paintCodeSelection(start: Int, end: Int): CodeSelectionPaint? {
    // The TextView reports a selection from its own constructor, before this view's fields exist.
    if (layout == null) return null
    val chrome = codeChrome
    // A handle drag moves one end and reports it as either; the end that stayed is where the gesture started.
    val anchor = if (start != chrome.lastStart && end == chrome.lastEnd) end else start
    val head = if (anchor == end && start != end) start else end
    chrome.lastStart = start
    chrome.lastEnd = end
    val painted = codeSelectionFor(anchor, head)
    // The line numbers brighten with the selection, and they are drawn with the card, not the text.
    val near = codeRangesNear(editableText ?: return null, minOf(start, end), maxOf(start, end)).isNotEmpty()
    if (near || chrome.lastNear) invalidate()
    chrome.lastNear = near
    if (painted == null && codeChrome.selection == null) return null
    codeChrome.selection = painted
    refreshCodeHighlight()
    invalidate()
    return painted
}

/** The TextView's own highlight shows only while no block owns the selection's paint. */
internal fun TextFirstEditText.refreshCodeHighlight() {
    highlightColor = if (selectedCodeBlock != null || codeChrome.selection != null) 0 else style.selectionColor
}

/** Whether the painted selection takes the block whose code starts at [codeStart] whole. */
internal fun TextFirstEditText.isCodeBlockTakenWhole(codeStart: Int): Boolean {
    val painted = codeSelection ?: return false
    return painted.home == null && painted.start < painted.end && codeStart >= painted.start && codeStart < painted.end
}

/** The rows of [codeSelection] outside the blocks it takes whole, under the text. */
internal fun TextFirstEditText.drawCodeSelection(canvas: Canvas) {
    val painted = codeSelection ?: return
    if (painted.start >= painted.end) return
    val l = layout ?: return
    val e = editableText ?: return
    val paint = Paint().apply { color = this@drawCodeSelection.style.selectionColor }
    val save = canvas.save()
    canvas.translate(totalPaddingLeft.toFloat(), totalPaddingTop.toFloat())
    var from = painted.start
    val whole = if (painted.home == null) codeRangesNear(e, painted.start, painted.end).filter { painted.start <= it.start && painted.end >= it.end } else emptyList()
    for (block in whole) {
        drawSelectionRows(canvas, l, e, from, block.start, paint)
        from = block.end
    }
    drawSelectionRows(canvas, l, e, from, painted.end, paint)
    canvas.restoreToCount(save)
}

/** One rectangle per visual row from [from] to [to]: a row whose line break is selected runs to the right edge. */
private fun TextFirstEditText.drawSelectionRows(canvas: Canvas, l: Layout, e: Spanned, from: Int, to: Int, paint: Paint) {
    if (from >= to) return
    val firstLine = l.getLineForOffset(from)
    val lastLine = l.getLineForOffset(to)
    for (line in firstLine..lastLine) {
        val lineStart = l.getLineStart(line)
        val lineEnd = l.getLineEnd(line)
        if (line == lastLine && to == lineStart && line > firstLine) break
        val a = maxOf(from, lineStart)
        val breakSelected = to >= lineEnd && lineEnd > lineStart && e[lineEnd - 1] == '\n'
        val left = l.getPrimaryHorizontal(a)
        val right = if (breakSelected || line < lastLine) l.width.toFloat() else l.getPrimaryHorizontal(minOf(to, lineEnd))
        var top = l.getLineTop(line).toFloat()
        var bottom = l.getLineBottom(line).toFloat()
        val code = e.getSpans(lineStart, lineStart, TfCodeBlock::class.java).firstOrNull { e.getSpanEnd(it) > lineStart }
        if (code != null && code.line.first && e.getSpanStart(code) == lineStart) top += style.codeHeaderHeight
        if (code != null && code.line.last && lineEnd >= e.getSpanEnd(code) - 1) bottom -= code.bottomExtra(e)
        canvas.drawRect(minOf(left, right), top, maxOf(left, right), bottom, paint)
    }
}
