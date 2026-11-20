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
    val light = androidx.core.graphics.ColorUtils.calculateLuminance(style.codeBackground) > 0.5
    val blend = if (android.os.Build.VERSION.SDK_INT >= 29) {
        if (light) android.graphics.BlendMode.MULTIPLY else android.graphics.BlendMode.SCREEN
    } else null
    val save = canvas.save()
    canvas.translate(totalPaddingLeft.toFloat(), totalPaddingTop.toFloat())
    marks.visit(from, to) { s, en, current ->
        for (code in e.getSpans(s, en, TfInline::class.java)) {
            if (!code.code) continue
            val a = maxOf(s, e.getSpanStart(code))
            val b = minOf(en, e.getSpanEnd(code))
            if (b <= a) continue
            markPaint.color = style.findMarkColor(current)
            // The current match's text is drawn again on its mark (drawCurrentMatchText): the mark lies over plainly.
            if (android.os.Build.VERSION.SDK_INT >= 29) markPaint.blendMode = if (current) null else blend
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

/**
 * The current match's text, drawn again over its mark in the note's text colour: a link's, a tag's, a missing link's or
 * inline code's own colour does not read on the mark. Clipped to the mark, in a layer whose filter gives every glyph
 * drawn there that one colour (a wikilink's own label too); inline code is drawn without its chip for it.
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
    val clip = android.graphics.Path()
    l.getSelectionPath(match.first, (match.last + 1).coerceAtMost(e.length), clip)
    val label = android.graphics.Path()
    for (atom in e.getSpans(match.first, match.last + 1, TfWikilink::class.java)) {
        val atomStart = e.getSpanStart(atom)
        val atomEnd = e.getSpanEnd(atom)
        val labelAt = e.subSequence(atomStart, atomEnd).toString().lastIndexOf(atom.label).coerceAtLeast(0)
        val left = minOf(l.getPrimaryHorizontal(atomStart), l.getPrimaryHorizontal(atomEnd))
        atom.labelPath(atom.renderedPaint(paint), match.first - atomStart - labelAt, match.last + 1 - atomStart - labelAt,
            left, l.getLineBaseline(l.getLineForOffset(atomStart)).toFloat(), label)
        clip.addPath(label)
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
    style.drawingMatchText = true
    try {
        paint.color = currentTextColor
        l.draw(canvas)
    } finally {
        style.drawingMatchText = false
        e.drawWindow = window
        canvas.restoreToCount(save)
    }
}
