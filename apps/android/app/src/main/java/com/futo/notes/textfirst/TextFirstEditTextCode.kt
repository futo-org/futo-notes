package com.futo.notes.textfirst

import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF

/**
 * Each visible fenced block's card: its fill and hairline border, rounded at its first and last
 * code line, its line numbers (CodeGutter) and its header. The view paints them
 * ahead of the TextView's own drawing, because the TextView draws the caret before the layout's
 * line backgrounds: a LineBackgroundSpan would cover the caret.
 */
internal fun TextFirstEditText.drawCodeBlocks(canvas: Canvas) {
    codeChrome.clearTargets()
    val l = layout ?: return
    val e = editableText ?: return
    val top = scrollY - totalPaddingTop
    val firstLine = l.getLineForVertical(maxOf(0, top))
    val lastLine = l.getLineForVertical(maxOf(0, top + height))
    val lines = e.getSpans(l.getLineStart(firstLine), l.getLineEnd(lastLine), TfCodeBlock::class.java)
    if (lines.isEmpty()) return
    lines.sortBy { e.getSpanStart(it) }
    val save = canvas.save()
    canvas.translate(totalPaddingLeft.toFloat(), totalPaddingTop.toFloat())
    var from = 0
    while (from < lines.size) {
        var to = from
        while (to + 1 < lines.size && continuesCard(e, lines[to], lines[to + 1])) to++
        drawCodeCard(canvas, l, e, lines.copyOfRange(from, to + 1))
        from = to + 1
    }
    canvas.restoreToCount(save)
}

/**
 * Whether [next] is the code line after [line] in the same block. Not by comparing block facts: a
 * line restyled alone (typing in it) carries the block's new range while its neighbours keep the old.
 */
internal fun continuesCard(e: android.text.Spanned, line: TfCodeBlock, next: TfCodeBlock): Boolean =
    !line.line.last && !next.line.first && e.getSpanStart(next) <= e.getSpanEnd(line)

/** One block's visible [lines], in order. A side the viewport cuts off is drawn past the edge, square. */
private fun TextFirstEditText.drawCodeCard(canvas: Canvas, l: android.text.Layout, e: android.text.Editable, lines: Array<TfCodeBlock>) {
    val look = style
    val width = l.width.toFloat()
    val head = lines.first()
    val tail = lines.last()
    val overhang = look.codeRadius * 2
    val cardTop = l.getLineTop(l.getLineForOffset(e.getSpanStart(head))) - if (head.line.first) 0f else overhang
    val tailEnd = e.getSpanEnd(tail)
    val tailBottom = l.getLineBottom(l.getLineForOffset(maxOf(e.getSpanStart(tail), tailEnd - 1))).toFloat()
    val cardBottom = if (tail.line.last) tailBottom - tail.bottomExtra(e) + look.codeSkirt else tailBottom + overhang
    // The card stands a little past the text column, as !300's did, so code that wraps does not touch its border.
    val outset = look.codeCardOutset
    val card = RectF(-outset, cardTop, width + outset, cardBottom)
    codeCardPaint.style = Paint.Style.FILL
    codeCardPaint.color = look.codeWellColor
    canvas.drawRoundRect(card, look.codeRadius, look.codeRadius, codeCardPaint)
    val headStart = e.getSpanStart(head)
    // A block taken whole is painted as the card, beneath the hairline (!300 cb 349-351).
    if (isCardSelected(headStart) || isCodeBlockTakenWhole(headStart)) {
        codeCardPaint.color = look.selectionColor
        canvas.drawRoundRect(card, look.codeRadius, look.codeRadius, codeCardPaint)
    }
    drawCodeNumbers(canvas, l, e, lines)
    val stroke = look.dp(1f)
    codeCardPaint.style = Paint.Style.STROKE
    codeCardPaint.strokeWidth = stroke
    codeCardPaint.color = look.codeWellBorderColor
    card.inset(stroke / 2, stroke / 2)
    canvas.drawRoundRect(card, look.codeRadius, look.codeRadius, codeCardPaint)
    // A block whose header field is open is still the one being edited, as on !300 (job13 run 2, item 2).
    val openField = codeTouch.headerField.openField
    val blockStart = if (head.line.first) headStart else if (openField != null) e.codeBlockRange(head).start else -1
    val editingHeader = openField?.first == blockStart
    val active = editingHeader || isCardActive(e, head, tail)
    // Its caret inside or the block selected (cb 97-105); not a range only part of it (area 6 verifier).
    val revealFields = editingHeader || (active && (selectionStart == selectionEnd || isCardSelected(headStart)))
    if (head.line.first && headStart == 0) codeChrome.addSpaceAbove(headStart, width, cardTop)
    if (head.line.first) codeChrome.drawHeader(canvas, CodeHeaderState(head.line.block, headStart, -outset, width + outset, cardTop, active && opensLineAbove(e, head), revealFields, openField?.takeIf { editingHeader }?.second))
    if (!tail.line.last) return
    val endsNote = tailEnd >= e.length - TextFirstEditText.END_SENTINEL.length
    // Under a block that ends the note the label sits under the card, its space already the target (cb 791-797);
    // between two blocks it sits in the skirt and its press reaches down across the gap (cb 841-844).
    // With neither block active the gap between them is still page: a press there opens a line (cb 841-844).
    when {
        active && endsNote -> codeChrome.drawLineBelow(canvas, headStart, width, cardBottom + look.codeSkirt * 0.3f, cardBottom + look.codeSkirt * 1.6f)
        !tail.touchesBlockBelow(e) -> Unit
        active -> codeChrome.drawLineBelow(canvas, headStart, width, cardBottom - look.codeSkirt * 1.2f, cardBottom + look.codeBlockGap)
        else -> codeChrome.addGapBelow(headStart, width, cardBottom, cardBottom + look.codeBlockGap)
    }
    if (endsNote) codeChrome.addSpaceBelow(headStart, width, cardBottom)
}

/** The block holds the caret or the selection: on touch, only its "add a line" affordances show. */
private fun TextFirstEditText.isCardActive(e: android.text.Editable, head: TfCodeBlock, tail: TfCodeBlock): Boolean {
    if (!isFocused) return false
    val start = if (head.line.first) e.getSpanStart(head) else e.codeBlockRange(head).start
    // The block's last line break is not in it: a caret on the line opened under it is outside.
    val end = if (tail.line.last) codeLineEnd(e, tail) else e.codeBlockRange(tail).end
    return selectionStart >= start && selectionEnd <= end
}

/** No ordinary line reaches the block from above: it starts the note, or another block ends right above it. */
private fun opensLineAbove(e: android.text.Editable, head: TfCodeBlock): Boolean {
    val start = e.getSpanStart(head)
    if (start == 0) return true
    return e.getSpans(start - 1, start, TfCodeBlock::class.java).any { it !== head && it.line.last }
}

private fun TextFirstEditText.isCardSelected(codeStart: Int): Boolean =
    selectedCodeBlock?.let { codeStart >= it.first && codeStart <= it.second } ?: false


/**
 * The text scrolled under the top padding. The TextView clips a scrolled view to
 * its padding box and offsets the text by the same padding, so unlike the bottom
 * (see `drawing`) the top padding cannot be zeroed for the clip alone: this draws
 * the layout once more, clipped to the padding band only.
 */
internal fun TextFirstEditText.drawTopPaddingBand(canvas: Canvas) {
    val l = layout ?: return
    if (scrollY <= 0 || totalPaddingTop <= 0) return
    val save = canvas.save()
    canvas.clipRect(0f, scrollY.toFloat(), width.toFloat() + scrollX, (scrollY + totalPaddingTop).toFloat())
    canvas.translate(totalPaddingLeft.toFloat(), totalPaddingTop.toFloat())
    // A whole-note selection can span thousands of lines; only build the path
    // for this band and one context line either side. Layout excludes extra
    // line spacing from a selection's first/last row, but includes it between
    // rows; the context keeps that native geometry inside the exposed band.
    val first = (l.getLineForVertical((scrollY - totalPaddingTop).coerceAtLeast(0)) - 1).coerceAtLeast(0)
    val last = (l.getLineForVertical(scrollY) + 1).coerceAtMost(l.lineCount - 1)
    val start = maxOf(minOf(selectionStart, selectionEnd), l.getLineStart(first))
    val end = minOf(maxOf(selectionStart, selectionEnd), l.getLineEnd(last))
    val selection = if (start >= 0 && end > start) Path().also { l.getSelectionPath(start, end, it) } else null
    val paint = Paint().apply { color = highlightColor }
    if (android.os.Build.VERSION.SDK_INT >= 34) {
        // On API36 the legacy overload passes null highlight lists and Layout
        // returns before drawing its selection. Empty lists keep that path live.
        l.draw(canvas, emptyList(), emptyList(), selection, paint, 0)
    } else {
        l.draw(canvas, selection, paint, 0)
    }
    canvas.restoreToCount(save)
}

/**
 * A hairline along the top edge while the note is scrolled. Text scrolls all the
 * way to this edge (see drawTopPaddingBand), which sits a few dp under the title
 * row; without an edge a heading cut there reads as drawn over the title.
 */
internal fun TextFirstEditText.drawScrollEdge(canvas: Canvas) {
    if (scrollY <= 0) return
    val paint = Paint().apply { color = this@drawScrollEdge.style.borderColor }
    val top = scrollY.toFloat()
    canvas.drawRect(scrollX.toFloat(), top, (scrollX + width).toFloat(), top + maxOf(1f, style.dp(1f)), paint)
}
