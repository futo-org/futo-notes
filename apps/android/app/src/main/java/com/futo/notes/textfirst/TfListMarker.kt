package com.futo.notes.textfirst

import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import android.text.TextDirectionHeuristic
import android.text.TextDirectionHeuristics
import android.text.style.ReplacementSpan

/**
 * A list item's marker (`- `, `10. `, `- [ ] `) as the one character the engine puts at the item's start: it draws the
 * bullet, number or checkbox in its item's marker column, beside the text on whichever side the paragraph reads from.
 * Its own paint: a checked task's strike and mute (TfList) stay on the text.
 */
internal class TfListMarker(
    private val look: TextFirstStyle,
    val depth: Int,
    val marker: ListMarker,
    val label: String,
    val checked: Boolean,
    /** How the view decides a paragraph's direction, as its layout does. */
    private val direction: () -> TextDirectionHeuristic,
) : ReplacementSpan(), TfAtom {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val lead = listLead(look, depth)

    /** The column's width as laid out: the hanging margin (TfList) less the first row's, so wrapped rows meet the text. */
    val width: Int = (lead + listMarkerColumn(look, marker, label)).toInt() - lead.toInt()

    override fun getSize(paint: Paint, text: CharSequence?, start: Int, end: Int, fm: Paint.FontMetricsInt?): Int = width

    override fun draw(canvas: Canvas, text: CharSequence?, start: Int, end: Int, x: Float, top: Int, y: Int, bottom: Int, paint: Paint) {
        // The marker sits between the margin and the text: in a right-to-left item the text is on its left.
        val rtl = text != null && rightToLeft(text, end, direction())
        val near = if (rtl) x else x + width
        fun towardsText(offset: Float) = if (rtl) near + offset else near - offset
        this.paint.color = look.textColor
        this.paint.textSize = look.textSizePx
        this.paint.typeface = look.regular
        when (marker) {
            ListMarker.Bullet -> {
                val radius = look.textSizePx * 2.6f / 17f
                val cy = y - look.textSizePx * 0.32f
                this.paint.style = Paint.Style.FILL
                if (depth % 2 == 1) { this.paint.style = Paint.Style.STROKE; this.paint.strokeWidth = look.textSizePx * 1.2f / 17f }
                canvas.drawCircle(towardsText(width * 0.55f), cy, radius, this.paint)
                this.paint.style = Paint.Style.FILL
            }
            ListMarker.Ordered -> {
                this.paint.textAlign = if (rtl) Paint.Align.LEFT else Paint.Align.RIGHT
                this.paint.color = look.mutedColor
                canvas.drawText(label, towardsText(look.dp(LIST_NUMBER_GAP_DP)), y.toFloat(), this.paint)
                this.paint.textAlign = Paint.Align.LEFT
            }
            ListMarker.Task -> drawCheckbox(canvas, y, towardsText(look.dp(6f)), towardsText(look.textSizePx * 0.95f + look.dp(6f)))
        }
    }

    private fun drawCheckbox(canvas: Canvas, baseline: Int, a: Float, b: Float) {
        val size = look.textSizePx * 0.95f
        val cy = baseline - look.textSizePx * 0.35f
        val box = RectF(minOf(a, b), cy - size / 2, maxOf(a, b), cy + size / 2)
        paint.strokeWidth = look.dp(1.5f)
        if (checked) {
            paint.style = Paint.Style.FILL
            paint.color = look.linkColor
            canvas.drawRoundRect(box, look.dp(3f), look.dp(3f), paint)
            paint.style = Paint.Style.STROKE
            paint.color = 0xFFFFFFFF.toInt()
            paint.strokeWidth = look.dp(2f)
            canvas.drawLine(box.left + size * 0.22f, cy, box.left + size * 0.42f, cy + size * 0.2f, paint)
            canvas.drawLine(box.left + size * 0.42f, cy + size * 0.2f, box.right - size * 0.2f, cy - size * 0.22f, paint)
        } else {
            paint.style = Paint.Style.STROKE
            paint.color = look.mutedColor
            canvas.drawRoundRect(box, look.dp(3f), look.dp(3f), paint)
        }
        paint.style = Paint.Style.FILL
    }
}

/**
 * Whether the paragraph that continues from [from] reads right to left, judged by the view's own [heuristic] (an empty or
 * digits-only item follows the view's direction). Its first strong letter decides, so only a bounded stretch is read.
 */
private fun rightToLeft(text: CharSequence, from: Int, heuristic: TextDirectionHeuristic): Boolean {
    var end = from
    val limit = minOf(text.length, from + DIRECTION_SCAN_CHARS)
    while (end < limit && text[end] != '\n') end++
    return heuristic.isRtl(text, from, end - from)
}

private const val DIRECTION_SCAN_CHARS = 512

/** The text direction the note's layout uses: its heuristic, or on API 28 the first-strong rule for its layout direction. */
internal fun TextFirstEditText.markerTextDirection(): TextDirectionHeuristic =
    if (android.os.Build.VERSION.SDK_INT >= 29) textDirectionHeuristic
    else if (layoutDirection == android.view.View.LAYOUT_DIRECTION_RTL) TextDirectionHeuristics.FIRSTSTRONG_RTL
    else TextDirectionHeuristics.FIRSTSTRONG_LTR
