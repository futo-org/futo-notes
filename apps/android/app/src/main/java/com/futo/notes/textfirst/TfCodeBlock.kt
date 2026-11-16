package com.futo.notes.textfirst

import android.graphics.Canvas
import android.graphics.Paint
import android.text.Layout
import android.text.Spanned
import android.text.TextPaint
import android.text.TextUtils
import android.text.style.LeadingMarginSpan
import android.text.style.LineHeightSpan
import android.text.style.MetricAffectingSpan

/**
 * A code line's monospace face and inset, and on a block's first line its language label's
 * header. Its background is not a LineBackgroundSpan: the TextView draws the caret before the
 * layout's line backgrounds, so an opaque one would cover the caret on a code line. The view
 * paints the background and the label first instead (`drawCodeBackgrounds`).
 */
internal class TfCodeBlock(private val look: TextFirstStyle, val language: String?) :
    MetricAffectingSpan(), LeadingMarginSpan, LineHeightSpan, TfSpan {
    private val labelPaint = language?.let { TextPaint(Paint.ANTI_ALIAS_FLAG).apply { typeface = look.mono; textSize = look.codeLabelSize } }

    override fun slice(head: Boolean): TfSpan = if (head) this else TfCodeBlock(look, null)

    override fun updateMeasureState(paint: TextPaint) {
        paint.typeface = look.mono
        paint.textSize = look.textSizePx * 0.85f
    }

    override fun updateDrawState(paint: TextPaint) = updateMeasureState(paint)

    override fun getLeadingMargin(first: Boolean) = look.codePadding.toInt()
    override fun drawLeadingMargin(c: Canvas, p: Paint, x: Int, dir: Int, top: Int, baseline: Int, bottom: Int, text: CharSequence, start: Int, end: Int, first: Boolean, layout: Layout?) = Unit

    override fun chooseHeight(text: CharSequence, start: Int, end: Int, spanstartv: Int, lineHeight: Int, fm: Paint.FontMetricsInt) {
        if (labelPaint == null || start != (text as Spanned).getSpanStart(this)) return
        val header = look.codeLabelHeader.toInt()
        fm.ascent -= header
        fm.top -= header
    }

    /** The label at the top right of the header whose line starts at [top], within half of [width]. */
    fun drawLabel(canvas: Canvas, width: Int, top: Int) {
        val paint = labelPaint ?: return
        val label = checkNotNull(language)
        paint.color = look.mutedColor
        val shown = TextUtils.ellipsize(label, paint, width / 2f - look.codePadding, TextUtils.TruncateAt.END)
        val metrics = paint.fontMetrics
        val baseline = top + (look.codeLabelHeader - metrics.descent - metrics.ascent) / 2f
        val right = width - look.codePadding
        canvas.drawText(shown, 0, shown.length, right - paint.measureText(shown, 0, shown.length), baseline, paint)
    }
}
