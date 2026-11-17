package com.futo.notes.textfirst

import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import uniffi.futo_notes_ffi.EditorCodeLineMark

/**
 * Each visible fenced block's card: its fill and hairline border, rounded at its first and last
 * code line, the `hl:`/`ll:` bands across the card's width, and its header. The view paints them
 * ahead of the TextView's own drawing, because the TextView draws the caret before the layout's
 * line backgrounds: a LineBackgroundSpan would cover the caret.
 */
internal fun TextFirstEditText.drawCodeBlocks(canvas: Canvas) {
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
private fun continuesCard(e: android.text.Editable, line: TfCodeBlock, next: TfCodeBlock): Boolean =
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
    val card = RectF(0f, cardTop, width, cardBottom)
    codeCardPaint.style = Paint.Style.FILL
    codeCardPaint.color = look.codeWellColor
    canvas.drawRoundRect(card, look.codeRadius, look.codeRadius, codeCardPaint)
    for (span in lines) {
        val mark = span.line.mark ?: continue
        val start = e.getSpanStart(span)
        val end = e.getSpanEnd(span)
        val bandTop = l.getLineTop(l.getLineForOffset(start)) + if (span.line.first) look.codeHeaderHeight else 0f
        val bandBottom = l.getLineBottom(l.getLineForOffset(maxOf(start, end - 1))) - if (span.line.last) span.bottomExtra(e) else 0f
        codeCardPaint.color = if (mark == EditorCodeLineMark.HIGHLIGHT) look.codeHighlightColor else look.codeLowlightColor
        canvas.drawRect(0f, bandTop, width, bandBottom, codeCardPaint)
    }
    val stroke = look.dp(1f)
    codeCardPaint.style = Paint.Style.STROKE
    codeCardPaint.strokeWidth = stroke
    codeCardPaint.color = look.codeWellBorderColor
    card.inset(stroke / 2, stroke / 2)
    canvas.drawRoundRect(card, look.codeRadius, look.codeRadius, codeCardPaint)
    if (isCardSelected(e.getSpanStart(head))) drawSelectedCard(canvas, card)
    if (head.line.first) codeHeader.draw(canvas, head.line.block, width, cardTop)
}

private fun TextFirstEditText.isCardSelected(codeStart: Int): Boolean =
    selectedCodeBlock?.let { codeStart >= it.first && codeStart <= it.second } ?: false

private fun TextFirstEditText.drawSelectedCard(canvas: Canvas, card: RectF) {
    val look = style
    codeCardPaint.style = Paint.Style.FILL
    codeCardPaint.color = look.selectionColor
    canvas.drawRoundRect(card, look.codeRadius, look.codeRadius, codeCardPaint)
    val ring = look.dp(1.5f)
    codeCardPaint.style = Paint.Style.STROKE
    codeCardPaint.strokeWidth = ring
    codeCardPaint.color = look.linkColor
    card.inset(ring / 2, ring / 2)
    canvas.drawRoundRect(card, look.codeRadius, look.codeRadius, codeCardPaint)
}

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
