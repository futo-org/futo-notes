package com.futo.notes.textfirst

import android.graphics.Canvas

// Find painting for the note view: matches are drawn behind the text and inside
// grid cells; the Editable's text and spans are never edited for them.

/** Show the engine's matches. Painting only: the Editable's text and spans are not edited. */
internal fun TextFirstEditText.setFind(snapshot: FindSnapshot) {
    if (marks.isEmpty && (!snapshot.open || snapshot.matches.isEmpty())) { marks.set(snapshot); return }
    marks.set(snapshot)
    redrawTableRows()
    invalidate()
}

/** Scroll a note line into view without changing a table's independent horizontal pan. */
internal fun TextFirstEditText.revealLine(start: Int): Int? {
    val l = layout ?: return null
    val e = editableText ?: return null
    restoring = null // the reader asked to go somewhere else
    stopPinning()
    val at = start.coerceIn(0, (e.length - 1).coerceAtLeast(0))
    val line = l.getLineForOffset(at)
    val viewport = height - totalPaddingTop - totalPaddingBottom
    val top = l.getLineTop(line); val bottom = l.getLineBottom(line)
    if (viewport > 0 && (top < scrollY || bottom > scrollY + viewport)) {
        val maxScroll = (l.height + totalPaddingTop + totalPaddingBottom - height).coerceAtLeast(0)
        scrollTo(scrollX, (top - viewport / 3).coerceIn(0, maxScroll))
    }
    invalidate()
    return at
}

/** Scroll a match into view: its line vertically, and its column inside a wide grid. */
internal fun TextFirstEditText.revealRange(start: Int, end: Int) {
    val at = revealLine(start) ?: return
    val e = editableText ?: return
    e.getSpans(at, at, TfTableRow::class.java).firstOrNull()?.let { row ->
        val shift = e.getSpanStart(row) - row.displayStart
        if (row.revealCell(at - shift)) redrawTableRows()
    }
    invalidate()
}

internal fun TextFirstEditText.drawFindMarks(canvas: Canvas) {
    if (marks.isEmpty) return
    val l = layout ?: return
    val e = editableText ?: return
    val top = scrollY - totalPaddingTop
    val from = l.getLineStart(l.getLineForVertical(maxOf(0, top)))
    val to = l.getLineEnd(l.getLineForVertical(maxOf(0, top + height)))
    val markPaint = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG)
    val markPath = android.graphics.Path()
    val save = canvas.save()
    canvas.translate(totalPaddingLeft.toFloat(), totalPaddingTop.toFloat())
    marks.visit(from, to) { s, en, current ->
        // A grid row paints its own matches inside its cells.
        if (e.getSpans(s, s, TfTableRow::class.java).isNotEmpty()) return@visit
        markPath.rewind()
        l.getSelectionPath(s, en.coerceAtMost(e.length), markPath)
        markPaint.color = style.findMarkColor(current)
        canvas.drawPath(markPath, markPaint)
    }
    canvas.restoreToCount(save)
}

/** TextView caches span drawing: re-set each grid row (or those matching [only]) so it repaints. */
internal fun TextFirstEditText.redrawTableRows(only: (TfTableRow) -> Boolean = { true }) {
    val e = editableText ?: return
    applying = true
    try {
        for (span in e.getSpans(0, e.length, TfTableRow::class.java)) {
            if (only(span)) e.setSpan(span, e.getSpanStart(span), e.getSpanEnd(span), e.getSpanFlags(span))
        }
    } finally { applying = false }
}

