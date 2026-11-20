package com.futo.notes.textfirst

import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import android.text.TextPaint
import android.text.style.MetricAffectingSpan

/**
 * A list item's marker (`- `, `10. `, `- [ ] `) as the one character the engine puts at the item's start: its U+FFFC is
 * scaled to the item's marker column and drawn clear, and its item's row (TfList) draws the bullet, number or checkbox
 * in that column. Not a ReplacementSpan: a replaced run always lets the line break right after it, leaving the marker
 * alone on its row above an over-long first word (ListMarkerKeep holds the two together).
 */
internal class TfListMarker(
    private val look: TextFirstStyle,
    val depth: Int,
    val marker: ListMarker,
    val label: String,
    val checked: Boolean,
) : MetricAffectingSpan(), TfAtom {
    private val lead = listLead(look, depth)

    /** The column's width as laid out: the hanging margin (TfList) less the first row's, so wrapped rows meet the text. */
    val width: Int = (lead + listMarkerColumn(look, marker, label)).toInt() - lead.toInt()

    private var fittedSize = -1f
    private var fittedFace: android.graphics.Typeface? = null
    private var fittedScale = 1f

    override fun updateMeasureState(tp: TextPaint) = fit(tp)

    // The character's own glyph is not drawn, and a checked task strikes its row's text, not its box.
    override fun updateDrawState(tp: TextPaint) {
        fit(tp)
        tp.color = android.graphics.Color.TRANSPARENT
        tp.isStrikeThruText = false
        tp.isUnderlineText = false
    }

    /** Scale the character so its advance is the column's [width]: measured, then corrected twice for rounding. */
    private fun fit(tp: TextPaint) {
        if (tp.textSize != fittedSize || tp.typeface != fittedFace) {
            fittedSize = tp.textSize
            fittedFace = tp.typeface
            var scale = 1f
            repeat(3) {
                tp.textScaleX = scale
                scale *= width / tp.measureText(MARKER_UNIT)
            }
            fittedScale = scale
        }
        tp.textScaleX = fittedScale
    }
}

/** The character the engine puts where an item's marker is. */
private const val MARKER_UNIT = "\uFFFC"

private val markerPaint = Paint(Paint.ANTI_ALIAS_FLAG)

/**
 * Draw an item's bullet, number or checkbox in its marker column, whose text-side edge is [near] (canvas x); the text is
 * to the right, or to the left when [rtl]. UI thread.
 */
internal fun drawListMarker(canvas: Canvas, look: TextFirstStyle, item: TfList, near: Float, rtl: Boolean, baseline: Int, width: Float) {
    fun towardsText(offset: Float) = if (rtl) near + offset else near - offset
    val paint = markerPaint
    paint.color = look.textColor
    paint.textSize = look.textSizePx
    paint.typeface = look.regular
    paint.style = Paint.Style.FILL
    when (item.marker) {
        ListMarker.Bullet -> {
            val radius = look.textSizePx * 2.6f / 17f
            val cy = baseline - look.textSizePx * 0.32f
            if (item.depth % 2 == 1) { paint.style = Paint.Style.STROKE; paint.strokeWidth = look.textSizePx * 1.2f / 17f }
            canvas.drawCircle(towardsText(width * 0.55f), cy, radius, paint)
        }
        ListMarker.Ordered -> {
            paint.textAlign = if (rtl) Paint.Align.LEFT else Paint.Align.RIGHT
            paint.color = look.mutedColor
            canvas.drawText(item.label, towardsText(look.dp(LIST_NUMBER_GAP_DP)), baseline.toFloat(), paint)
            paint.textAlign = Paint.Align.LEFT
        }
        ListMarker.Task -> drawCheckbox(canvas, look, paint, item.checked, baseline, towardsText(look.dp(6f)), towardsText(look.textSizePx * 0.95f + look.dp(6f)))
    }
    paint.style = Paint.Style.FILL
}

private fun drawCheckbox(canvas: Canvas, look: TextFirstStyle, paint: Paint, checked: Boolean, baseline: Int, a: Float, b: Float) {
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
}
