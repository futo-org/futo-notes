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
/** What the selection painter remembers between the view's selection reports. */
internal class CodeSelectionTracker {
    /** The selection a block owns the paint of. */
    var painted: CodeSelectionPaint? = null
    /** The view's last reported selection ends, to tell which end a handle moved. */
    var lastStart = -1
    var lastEnd = -1
    /** Whether the last selection was near a block, so its line numbers need repainting when it leaves. */
    var lastNear = false
}

internal class CodeSelectionPaint(
    /** The resolved range, start first. */
    val start: Int,
    val end: Int,
    /** The block whose code holds the anchor, or null when blocks are taken whole. */
    val home: CodeRange?,
    /** The blocks this selection takes whole, painted as their cards. */
    val whole: List<CodeRange>,
)

/** The code blocks with spans in [from, to], each whole however far it runs past them. */
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
        val start = if (head.line.first) e.getSpanStart(head) else e.codeBlockRange(head).start
        val end = if (tail.line.last) codeLineEnd(e, tail) else e.codeBlockRange(tail).end
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

/**
 * What [anchor] to [head] paints, or null when no block is near it (the TextView paints it). A [settled]
 * selection came from the engine, already resolved (Select All, an undo): it is painted as it is, not as a drag.
 */
internal fun TextFirstEditText.codeSelectionFor(anchor: Int, head: Int, settled: Boolean = false): CodeSelectionPaint? {
    val e = editableText ?: return null
    // A caret paints nothing of its own, and resolving it would walk its block's lines on every keystroke.
    if (anchor < 0 || head < 0 || anchor == head) return null
    val blocks = codeRangesNear(e, minOf(anchor, head), maxOf(anchor, head))
    if (blocks.isEmpty()) return null
    val (start, end) = if (settled) minOf(anchor, head) to maxOf(anchor, head) else resolveCodeSelection(anchor, head, blocks)
    // A block selected as one object is painted as its card alone.
    if (selectedCodeBlock == (start to end)) return null
    val home = if (settled) blocks.firstOrNull { it.start < it.end && start >= it.start && end <= it.end }
        else blocks.firstOrNull { it.start < it.end && anchor >= it.start && anchor <= it.end }
    if (home == null && blocks.none { start <= it.start && end >= it.end }) return null
    return CodeSelectionPaint(start, end, home, if (home == null) blocks.filter { start <= it.start && end >= it.end } else emptyList())
}

internal val TextFirstEditText.codeSelection: CodeSelectionPaint? get() = codeSelectionTracker.painted

/** Repaint for the view's new selection, [start] to [end] as it reports them; returns what is painted, null when the TextView paints it. */
internal fun TextFirstEditText.paintCodeSelection(start: Int, end: Int, settled: Boolean = false): CodeSelectionPaint? {
    // The TextView reports a selection from its own constructor, before this view's fields exist.
    if (layout == null) return null
    refreshCodeHighlight()
    val chrome = codeSelectionTracker
    // A handle drag moves one end and reports it as either; the end that stayed is where the gesture started.
    val anchor = if (start != chrome.lastStart && end == chrome.lastEnd) end else start
    val head = if (anchor == end && start != end) start else end
    chrome.lastStart = start
    chrome.lastEnd = end
    val painted = codeSelectionFor(anchor, head, settled)
    // The line numbers brighten with the selection, and they are drawn with the card, not the text.
    val e = editableText ?: return null
    val near = e.getSpans(maxOf(0, minOf(start, end) - 1), minOf(e.length, maxOf(start, end) + 1), TfCodeBlock::class.java).isNotEmpty()
    if (near || chrome.lastNear) invalidate()
    chrome.lastNear = near
    if (painted == null && chrome.painted == null) return null
    chrome.painted = painted
    refreshCodeHighlight()
    invalidate()
    return painted
}

/**
 * The TextView's own highlight never shows over prose: a block, an object (an image) selected whole, a table row
 * (TableSelectionPaint) or the text's rows (TextSelectionPaint) paint every selection; it shows only while none does.
 */
internal fun TextFirstEditText.refreshCodeHighlight() {
    val hidden = selectedCodeBlock != null || codeSelectionTracker.painted != null || selectedObject != null ||
        selectedTableRows().isNotEmpty() || isTextSelectionPainted()
    val color = if (hidden) 0 else style.selectionColor
    if (highlightColor != color) highlightColor = color
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
    val paint = codeChrome.selectionPaint.apply { color = this@drawCodeSelection.style.selectionColor }
    val save = canvas.save()
    canvas.translate(totalPaddingLeft.toFloat(), totalPaddingTop.toFloat())
    var from = painted.start
    for (block in painted.whole) {
        drawSelectionRows(canvas, l, e, from, block.start, paint)
        // The card paints the block, its last line to the edge too: go on from the line after it.
        from = if (block.end < e.length && e[block.end] == '\n') block.end + 1 else block.end
    }
    drawSelectionRows(canvas, l, e, from, painted.end, paint)
    canvas.restoreToCount(save)
}

/** One rectangle per visual row from [from] to [to]: a code row whose line break is selected runs to the card's side; a prose row covers its text. */
internal fun TextFirstEditText.drawSelectionRows(canvas: Canvas, l: Layout, e: Spanned, from: Int, to: Int, paint: Paint) {
    if (from >= to) return
    val firstLine = l.getLineForOffset(from)
    val lastLine = l.getLineForOffset(to)
    for (line in firstLine..lastLine) {
        val lineStart = l.getLineStart(line)
        val lineEnd = l.getLineEnd(line)
        if (line == lastLine && to == lineStart && line > firstLine) break
        // A prose row is tinted over its text, as a selection without a block is (TextSelectionPaint).
        if (e.getSpans(lineStart, lineStart, TfCodeBlock::class.java).none { e.getSpanEnd(it) > lineStart }) {
            drawTextSelectionRow(canvas, l, e, line, from, to, paint)
            continue
        }
        val a = maxOf(from, lineStart)
        val breakSelected = to >= lineEnd && lineEnd > lineStart && e[lineEnd - 1] == '\n'
        val rightToLeft = l.getParagraphDirection(line) < 0
        // A row whose line break is selected runs out to the line's far side: the left one on a right-to-left line.
        val left = l.getPrimaryHorizontal(a)
        val right = if (breakSelected || line < lastLine) (if (rightToLeft) 0f else l.width.toFloat()) else l.getPrimaryHorizontal(minOf(to, lineEnd))
        val (top, bottom) = overlayBand(l, e, line)
        // Rounded where the run stops mid-text, square where it runs out to the block's side (!300 cb 591-597).
        // The run's start and end are sides of the text, not of the screen: a right-to-left line starts on the right.
        val roundStart = line == firstLine && a > lineStart
        val roundEnd = line == lastLine && !breakSelected
        val roundLeft = if (rightToLeft) roundEnd else roundStart
        val roundRight = if (rightToLeft) roundStart else roundEnd
        if (!roundLeft && !roundRight) {
            canvas.drawRect(minOf(left, right), top, maxOf(left, right), bottom, paint)
            continue
        }
        val chrome = codeChrome
        val radius = style.codeRadius / 2f
        val radii = chrome.selectionRadii
        for (i in 0..7) radii[i] = if ((i in 0..1 || i in 6..7) && roundLeft || (i in 2..5) && roundRight) radius else 0f
        chrome.selectionPath.rewind()
        chrome.selectionRow.set(minOf(left, right), top, maxOf(left, right), bottom)
        chrome.selectionPath.addRoundRect(chrome.selectionRow, radii, android.graphics.Path.Direction.CW)
        canvas.drawPath(chrome.selectionPath, paint)
    }
}

/** A layout row's top and bottom without a code block's header above its first row or skirt below its last. */
internal fun TextFirstEditText.textRowBand(l: Layout, e: Spanned, line: Int): Pair<Float, Float> {
    val lineStart = l.getLineStart(line)
    val lineEnd = l.getLineEnd(line)
    var top = l.getLineTop(line).toFloat()
    var bottom = l.getLineBottom(line).toFloat()
    val code = e.getSpans(lineStart, lineStart, TfCodeBlock::class.java).firstOrNull { e.getSpanEnd(it) > lineStart }
    if (code != null && code.line.first && e.getSpanStart(code) == lineStart) top += style.codeHeaderHeight
    if (code != null && code.line.last && lineEnd >= e.getSpanEnd(code) - 1) bottom -= code.bottomExtra(e)
    return top to bottom
}
