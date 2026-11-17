package com.futo.notes.textfirst

import android.graphics.Canvas
import android.graphics.Paint
import android.text.Layout
import android.text.Spanned
import android.text.TextPaint
import android.text.style.LeadingMarginSpan
import android.text.style.LineHeightSpan
import android.text.style.MetricAffectingSpan

/**
 * One code line: its monospace face, the gutter it is inset by, the header above a block's first
 * line and the skirt under its last. The gutter rule is drawn in the leading margin and the number
 * with the card (CodeGutter), so neither is text; a right-to-left line draws them on its right,
 * beside where its text starts, as list markers do. The card, its border and the header are not a
 * LineBackgroundSpan: the TextView draws the caret before the layout's line backgrounds, so the
 * view paints them first instead (`drawCodeBlocks`).
 */
internal class TfCodeBlock(private val look: TextFirstStyle, val line: CodeLineFacts) :
    MetricAffectingSpan(), LeadingMarginSpan, LineHeightSpan, TfSpan {
    private val numberPaint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
        typeface = look.mono
        textSize = look.codeTextSize
    }
    private val rulePaint = Paint()
    /** Where the numbers end: two digits wide at least, one more per digit the block's count needs. */
    val numberEnd = look.codeCorner + maxOf(2, line.block.lineCount.toString().length) * numberPaint.measureText("0")
    val ruleX = numberEnd + look.codeChipPad
    private val codeInset = ruleX + look.dp(1f) + look.codeChipPad

    override fun slice(head: Boolean): TfSpan = if (head) this else TfCodeBlock(look, line)

    override fun updateMeasureState(paint: TextPaint) {
        paint.typeface = look.mono
        paint.textSize = look.codeTextSize
    }

    override fun updateDrawState(paint: TextPaint) = updateMeasureState(paint)

    override fun getLeadingMargin(first: Boolean): Int = codeInset.toInt()

    override fun drawLeadingMargin(c: Canvas, p: Paint, x: Int, dir: Int, top: Int, baseline: Int, bottom: Int, text: CharSequence, start: Int, end: Int, first: Boolean, layout: Layout?) {
        val spanned = text as? Spanned ?: return
        val spanStart = spanned.getSpanStart(this)
        val ruleTop = if (start == spanStart && line.first) top + look.codeHeaderHeight else top.toFloat()
        val ruleBottom = if (line.last && reachesSpanEnd(spanned, end)) bottom - bottomExtra(spanned) else bottom.toFloat()
        rulePaint.color = look.codeRuleColor
        val ruleLeft = if (dir < 0) x - ruleX - look.dp(1f) else x + ruleX
        c.drawRect(ruleLeft, ruleTop, ruleLeft + look.dp(1f), ruleBottom, rulePaint)
    }

    override fun chooseHeight(text: CharSequence, start: Int, end: Int, spanstartv: Int, lineHeight: Int, fm: Paint.FontMetricsInt) {
        val spanned = text as Spanned
        if (line.first && start == spanned.getSpanStart(this)) {
            val header = look.codeHeaderHeight.toInt()
            fm.ascent -= header
            fm.top -= header
        }
        if (line.last && reachesSpanEnd(spanned, end)) {
            val skirt = bottomExtra(spanned).toInt()
            fm.descent += skirt
            fm.bottom += skirt
        }
    }

    /** Whether a visual line ending at [end] is the span's last; a leading margin's line end leaves out its line break. */
    private fun reachesSpanEnd(text: Spanned, end: Int): Boolean {
        val spanEnd = text.getSpanEnd(this)
        return end >= spanEnd || (end == spanEnd - 1 && text[end] == '\n')
    }

    /** The skirt under the block's last line, and the gap that keeps a block directly under it apart. */
    fun bottomExtra(text: Spanned): Float = look.codeSkirt + if (touchesBlockBelow(text)) look.codeBlockGap else 0f

    fun touchesBlockBelow(text: Spanned): Boolean {
        val end = text.getSpanEnd(this)
        val next = if (end > 0 && text[end - 1] == '\n') end else end + 1
        if (next >= text.length) return false
        return text.getSpans(next, next + 1, TfCodeBlock::class.java).any { it.line.first && text.getSpanStart(it) == next }
    }
}
