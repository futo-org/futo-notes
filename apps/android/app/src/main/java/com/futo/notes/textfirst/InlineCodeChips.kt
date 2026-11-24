package com.futo.notes.textfirst

import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.text.Layout
import android.text.Spanned
import android.text.TextPaint
import android.text.style.MetricAffectingSpan

/**
 * Inline code's chip, as desktop draws it: the code's letters as seen (capital tops to descender bottoms) with a tenth of
 * its em above and below, inside its row, the text colour at 12% so a selection or find mark shows over it. A run that
 * wraps is one chip per row, rounded only at the run's real start and end. Its sides reach into the whitespace beside the
 * run, up to three tenths of an em, never over a neighbouring letter: the text has no width of its own for them.
 * Drawn under the text and every mark, layout coordinates from [fromY] to [toY].
 */
internal fun TextFirstEditText.drawInlineCodeChips(canvas: Canvas, fromY: Int, toY: Int) {
    val l = layout ?: return
    val e = editableText ?: return
    val from = l.getLineStart(l.getLineForVertical(maxOf(0, fromY)))
    val to = l.getLineEnd(l.getLineForVertical(maxOf(0, toY)))
    if (e.getSpans(from, to, TfInline::class.java).none { it.code }) return
    val save = canvas.save()
    canvas.translate(totalPaddingLeft.toFloat(), totalPaddingTop.toFloat())
    codeChrome.inlineChip.drawRuns(canvas, l, e, from, to, paint, style)
    canvas.restoreToCount(save)
}

/** 12% of the text colour. */
private const val CHIP_ALPHA = 0x1F000000

/** The scratch objects the chips are drawn with, kept by the view (CodeBlockChrome). */
internal class InlineCodeChip {
    val fill = Paint(Paint.ANTI_ALIAS_FLAG)
    private val paint = TextPaint()
    private val box = RectF()
    private val path = Path()
    private val radii = FloatArray(8)

    /**
     * Every code run of [e] between [from] and [to] as laid out in [l], in [l]'s own coordinates: the note's text, or a
     * table cell's. [basePaint] is the paint [l] draws plain text with.
     */
    fun drawRuns(canvas: Canvas, l: Layout, e: Spanned, from: Int, to: Int, basePaint: Paint, style: TextFirstStyle) {
        fill.color = (style.textColor and 0x00ffffff) or CHIP_ALPHA
        for (span in e.getSpans(from, to, TfInline::class.java)) {
            if (!span.code) continue
            val start = e.getSpanStart(span)
            val end = e.getSpanEnd(span)
            for (line in l.getLineForOffset(start)..l.getLineForOffset(maxOf(start, end - 1))) drawRow(basePaint, style, canvas, l, e, line, start, end)
        }
    }

    /** Row [line]'s part of the code run [start, end). */
    private fun drawRow(basePaint: Paint, style: TextFirstStyle, canvas: Canvas, l: Layout, e: Spanned, line: Int, start: Int, end: Int) {
        val a = maxOf(start, l.getLineStart(line))
        var b = minOf(end, l.getLineEnd(line))
        while (b > a && (e[b - 1] == '\n' || e[b - 1] == '\r')) b--
        if (b <= a) return
        paint.set(basePaint)
        for (span in e.getSpans(a, a + 1, MetricAffectingSpan::class.java)) span.updateMeasureState(paint)
        val (seenTop, seenBottom) = visibleLineSpan(paint)
        val em = paint.textSize
        val baseline = l.getLineBaseline(line)
        val top = maxOf(l.getLineTop(line).toFloat(), baseline + seenTop - em * PAD_Y)
        val bottom = minOf(l.getLineBottom(line).toFloat(), baseline + seenBottom + em * PAD_Y)
        val rtl = l.getParagraphDirection(line) < 0
        val xa = l.getPrimaryHorizontal(a)
        // A run that ends where the row wraps: its far side is the row's text edge.
        val xb = if (b == l.getLineEnd(line) && line + 1 < l.lineCount) (if (rtl) l.getLineLeft(line) else l.getLineRight(line)) else l.getPrimaryHorizontal(b)
        val opens = a == start
        val closes = b == end
        val before = if (opens) room(l, e, a - 1) * em else 0f
        val after = if (closes) room(l, e, b) * em else 0f
        // In reading order: the run's start is its left side on a left-to-right row, its right side on a right-to-left one.
        val (left, right) = if (!rtl) minOf(xa, xb) - before to maxOf(xa, xb) + after else minOf(xa, xb) - after to maxOf(xa, xb) + before
        val roundLeft = if (rtl) closes else opens
        val roundRight = if (rtl) opens else closes
        val radius = style.dp(RADIUS_DP)
        for (i in 0..7) radii[i] = if ((i < 2 || i > 5) && roundLeft || i in 2..5 && roundRight) radius else 0f
        box.set(left, top, right, bottom)
        path.rewind()
        path.addRoundRect(box, radii, Path.Direction.CW)
        canvas.drawPath(path, fill)
    }

    /** How far, in ems, the chip may reach past the run toward the character at [at]: into whitespace only, half of it. */
    private fun room(l: Layout, e: Spanned, at: Int): Float {
        if (at < 0 || at >= e.length) return PAD_X
        val c = e[at]
        if (c == '\n' || c == '\r') return PAD_X
        if (!c.isWhitespace()) return 0f
        val gap = kotlin.math.abs(l.getPrimaryHorizontal(at + 1) - l.getPrimaryHorizontal(at))
        return minOf(PAD_X, gap / 2f / maxOf(1f, paint.textSize))
    }

    private companion object {
        const val PAD_X = 0.3f
        const val PAD_Y = 0.1f
        const val RADIUS_DP = 4f
    }
}
