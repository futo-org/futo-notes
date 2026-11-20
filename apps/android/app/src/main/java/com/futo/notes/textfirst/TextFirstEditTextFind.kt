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
        val rows = canvas.save()
        canvas.clipRect(0f, textRowBand(l, e, l.getLineForOffset(s)).first, l.width.toFloat(), textRowBand(l, e, l.getLineForOffset(en)).second)
        canvas.drawPath(markPath, markPaint)
        canvas.restoreToCount(rows)
        // A wikilink draws its own label, where the layout sees one object: its matched characters are marked there.
        for (atom in e.getSpans(s, en, TfWikilink::class.java)) {
            val atomStart = e.getSpanStart(atom)
            // The drawn label ends the link's text ([[folder/Note]] draws Note, [[target|label]] its label); a hit in what
            // it hides is not drawn.
            val atomEnd = e.getSpanEnd(atom)
            val labelAt = e.subSequence(atomStart, atomEnd).toString().lastIndexOf(atom.label).coerceAtLeast(0)
            val line = l.getLineForOffset(atomStart)
            // Its left edge either way the line runs (right to left, the span's start is its right edge).
            val left = minOf(l.getPrimaryHorizontal(atomStart), l.getPrimaryHorizontal(atomEnd))
            atom.labelPath(atom.renderedPaint(paint), s - atomStart - labelAt, en - atomStart - labelAt,
                left, l.getLineBaseline(line).toFloat(), markPath)
            canvas.drawPath(markPath, markPaint)
        }
    }
    canvas.restoreToCount(save)
}

/**
 * Inline code paints its chip over what is drawn behind the text, the marks included: a match inside it is marked
 * over the drawn chip instead, blended so its text stays readable (multiplied on a light page, screened on a dark one).
 * Before Android 10 it is laid over plainly.
 */
internal fun TextFirstEditText.drawFindMarksOverCode(canvas: Canvas) {
    if (marks.isEmpty) return
    val l = layout ?: return
    val e = editableText ?: return
    val top = scrollY - totalPaddingTop
    val from = l.getLineStart(l.getLineForVertical(maxOf(0, top)))
    val to = l.getLineEnd(l.getLineForVertical(maxOf(0, top + height)))
    val markPaint = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG)
    if (android.os.Build.VERSION.SDK_INT >= 29) {
        val light = androidx.core.graphics.ColorUtils.calculateLuminance(style.codeBackground) > 0.5
        markPaint.blendMode = if (light) android.graphics.BlendMode.MULTIPLY else android.graphics.BlendMode.SCREEN
    }
    val save = canvas.save()
    canvas.translate(totalPaddingLeft.toFloat(), totalPaddingTop.toFloat())
    marks.visit(from, to) { s, en, current ->
        for (code in e.getSpans(s, en, TfInline::class.java)) {
            if (!code.code) continue
            val a = maxOf(s, e.getSpanStart(code))
            val b = minOf(en, e.getSpanEnd(code))
            if (b <= a) continue
            markPaint.color = style.findMarkColor(current)
            // Row by row over the code's own text: a wrapped run's middle rows would otherwise span the margin and gutter.
            for (row in l.getLineForOffset(a)..l.getLineForOffset(b)) drawTextSelectionRow(canvas, l, e, row, a, b, markPaint)
        }
    }
    canvas.restoreToCount(save)
}

/** TextView caches span drawing: re-set each grid row (or those matching [only]) so it repaints. */
internal fun TextFirstEditText.redrawTableRows(only: (TfTableRow) -> Boolean = { true }) {
    val e = editableText ?: return
    val wasApplying = applying
    applying = true
    try {
        for (span in e.getSpans(0, e.length, TfTableRow::class.java)) {
            if (only(span)) e.setSpan(span, e.getSpanStart(span), e.getSpanEnd(span), e.getSpanFlags(span))
        }
    } finally { applying = wasApplying }
}
