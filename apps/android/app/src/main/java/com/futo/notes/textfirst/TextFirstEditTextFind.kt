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

internal fun TextFirstEditText.drawFindMarks(canvas: Canvas, top: Int = scrollY - totalPaddingTop, bottom: Int = top + height) {
    if (marks.isEmpty) return
    val l = layout ?: return
    val e = editableText ?: return
    val from = l.getLineStart(l.getLineForVertical(maxOf(0, top)))
    val to = l.getLineEnd(l.getLineForVertical(maxOf(0, bottom)))
    val markPaint = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG)
    val markPath = android.graphics.Path()
    val save = canvas.save()
    canvas.translate(totalPaddingLeft.toFloat(), totalPaddingTop.toFloat())
    marks.visit(from, to) { s, en, current ->
        // A grid row paints its own matches inside its cells.
        if (e.getSpans(s, s, TfTableRow::class.java).isNotEmpty()) return@visit
        markPaint.color = style.findMarkColor(current)
        val stop = en.coerceAtMost(e.length)
        // Row by row, on the band a selection takes there.
        for (row in l.getLineForOffset(s)..l.getLineForOffset(maxOf(s, stop - 1))) {
            if (selectionRowShape(l, e, row, s, stop, markPath)) canvas.drawPath(markPath, markPaint)
        }
        // A wikilink draws its own label, where the layout sees one object: its matched characters are marked there.
        for (atom in e.getSpans(s, en, TfWikilink::class.java)) {
            if (wikilinkLabelMark(l, e, atom, s, en, markPath)) canvas.drawPath(markPath, markPaint)
        }
    }
    canvas.restoreToCount(save)
}

/** The part of [atom]'s drawn label that [s, en) covers, on its letters, into [out]; false with none. */
private fun TextFirstEditText.wikilinkLabelMark(l: android.text.Layout, e: android.text.Spanned, atom: TfWikilink, s: Int, en: Int, out: android.graphics.Path): Boolean {
    val atomStart = e.getSpanStart(atom)
    // The drawn label ends the link's text ([[folder/Note]] draws Note, [[target|label]] its label); a hit in what
    // it hides is not drawn.
    val atomEnd = e.getSpanEnd(atom)
    val labelAt = e.subSequence(atomStart, atomEnd).toString().lastIndexOf(atom.label).coerceAtLeast(0)
    val line = l.getLineForOffset(atomStart)
    // Its left edge either way the line runs (right to left, the span's start is its right edge).
    val left = minOf(l.getPrimaryHorizontal(atomStart), l.getPrimaryHorizontal(atomEnd))
    atom.labelPath(atom.renderedPaint(paint), s - atomStart - labelAt, en - atomStart - labelAt, left, l.getLineBaseline(line).toFloat(), out)
    if (out.isEmpty) return false
    // Each of a wrapped label's own rows stays its own: moved onto its letters, not stretched over the host row.
    out.offset(0f, lettersBelowFontBoxCentre(atom.renderedPaint(paint)))
    return true
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

/**
 * The current match's text, drawn again over its mark in the note's text colour: a link's, a tag's, a missing link's or
 * inline code's own colour does not read on the mark. Clipped to the mark, in a layer whose filter gives every glyph
 * drawn there that one colour (a wikilink's own label too).
 */
internal fun TextFirstEditText.drawCurrentMatchText(canvas: Canvas) {
    if (marks.isEmpty) return
    val l = layout ?: return
    val e = editableText as? ChunkedEditable ?: return
    val top = scrollY - totalPaddingTop
    val from = l.getLineStart(l.getLineForVertical(maxOf(0, top)))
    val to = l.getLineEnd(l.getLineForVertical(maxOf(0, top + height)))
    var range: IntRange? = null
    marks.visit(from, to) { s, en, current -> if (current) range = s until en }
    val match = range ?: return
    if (e.getSpans(match.first, match.first, TfTableRow::class.java).isNotEmpty()) return
    // The mark's own shape, row by row, and a wikilink's label.
    val clip = android.graphics.Path()
    val piece = android.graphics.Path()
    val stop = (match.last + 1).coerceAtMost(e.length)
    for (row in l.getLineForOffset(match.first)..l.getLineForOffset(match.last)) {
        if (selectionRowShape(l, e, row, match.first, stop, piece)) clip.addPath(piece)
    }
    for (atom in e.getSpans(match.first, match.last + 1, TfWikilink::class.java)) {
        if (wikilinkLabelMark(l, e, atom, match.first, match.last + 1, piece)) clip.addPath(piece)
    }
    val bounds = android.graphics.RectF().also { clip.computeBounds(it, true) }
    if (bounds.isEmpty) return
    val save = canvas.save()
    canvas.translate(totalPaddingLeft.toFloat(), totalPaddingTop.toFloat())
    canvas.clipPath(clip)
    val onMark = style.textColor
    val tint = android.graphics.Paint().apply { colorFilter = android.graphics.PorterDuffColorFilter(onMark, android.graphics.PorterDuff.Mode.SRC_IN) }
    canvas.saveLayer(bounds, tint)
    val window = e.drawWindow
    e.drawWindow = l.getLineStart(l.getLineForOffset(match.first))..l.getLineEnd(l.getLineForOffset(match.last))
    try {
        paint.color = currentTextColor
        l.draw(canvas)
    } finally {
        e.drawWindow = window
        canvas.restoreToCount(save)
    }
}
