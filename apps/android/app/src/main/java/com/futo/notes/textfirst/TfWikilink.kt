package com.futo.notes.textfirst

import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Typeface
import android.text.Layout
import android.text.StaticLayout
import android.text.TextPaint
import android.text.style.ReplacementSpan

/** A single caret object whose label can occupy several visual lines. */
internal class TfWikilink(
    private val look: TextFirstStyle,
    val label: String,
    val noteId: String?,
    private val maxWidth: (TfWikilink) -> Int,
) : ReplacementSpan(), TfAtom {
    private val text = TextPaint()
    private var labelLayout: StaticLayout? = null
    private var measuredWidth = 0
    private var measuredSize = -1f
    private var measuredFace: Typeface? = null
    private var measuredScale = 0f
    private var measuredSkew = 0f
    private val underline = Paint().apply {
        strokeWidth = look.dp(1f)
        pathEffect = android.graphics.DashPathEffect(floatArrayOf(look.dp(3f), look.dp(3f)), 0f)
    }

    /** The paint Android last measured or drew this label with, after enclosing heading,
     *  bold or code spans changed it. Hit testing must use it rather than the bare view paint. */
    private val rendered = TextPaint()
    private var renderedOnce = false

    fun renderedPaint(fallback: Paint): Paint = if (renderedOnce) rendered else fallback

    private fun remember(paint: Paint) {
        rendered.set(paint)
        renderedOnce = true
    }

    private fun layoutFor(paint: Paint): StaticLayout {
        val available = maxOf(1, maxWidth(this))
        if (labelLayout == null || measuredWidth != available || measuredSize != paint.textSize ||
            measuredFace !== paint.typeface || measuredScale != paint.textScaleX || measuredSkew != paint.textSkewX) {
            text.set(paint)
            text.color = if (noteId != null) look.linkColor else look.mutedColor
            // Short labels keep their inline width. A long label takes the
            // available paragraph width and Android wraps/shapes it, including
            // Unicode and words longer than the viewport.
            val width = kotlin.math.ceil(Layout.getDesiredWidth(label, text).toDouble()).toInt().coerceIn(1, available)
            labelLayout = StaticLayout.Builder.obtain(label, 0, label.length, text, width)
                .setIncludePad(false)
                .setLineSpacing(0f, 1.55f)
                .build()
            measuredWidth = available
            measuredSize = paint.textSize
            measuredFace = paint.typeface
            measuredScale = paint.textScaleX
            measuredSkew = paint.textSkewX
        }
        return labelLayout!!
    }

    /** Hit only painted label lines, excluding the unused rectangle beside them. */
    fun contains(paint: Paint, x: Float, baselineY: Float): Boolean {
        val layout = layoutFor(paint)
        val y = baselineY + layout.getLineBaseline(layout.lineCount - 1)
        if (y < 0 || y >= layout.height) return false
        val line = layout.getLineForVertical(y.toInt())
        return x >= layout.getLineLeft(line) && x <= layout.getLineRight(line)
    }

    /** How far along the label's wrapped lines (their widths summed) x falls, 0..1; null above or below the label. */
    fun runFraction(paint: Paint, x: Float, baselineY: Float): Float? {
        val layout = layoutFor(paint)
        val y = baselineY + layout.getLineBaseline(layout.lineCount - 1)
        if (y < 0 || y >= layout.height) return null
        val hit = layout.getLineForVertical(y.toInt())
        var total = 0f
        var before = 0f
        for (line in 0 until layout.lineCount) {
            val run = layout.getLineRight(line) - layout.getLineLeft(line)
            total += run
            if (line < hit) before += run
        }
        before += (x - layout.getLineLeft(hit)).coerceIn(0f, layout.getLineRight(hit) - layout.getLineLeft(hit))
        return if (total > 0f) before / total else 0f
    }

    override fun getSize(paint: Paint, text: CharSequence?, start: Int, end: Int, fm: Paint.FontMetricsInt?): Int {
        remember(paint)
        val layout = layoutFor(paint)
        if (fm != null && layout.lineCount > 1) {
            // Keep the final label baseline on the host line's baseline;
            // the atom owns all visual lines above it and one set of descenders.
            val metrics = paint.fontMetricsInt
            fm.ascent = -layout.getLineBaseline(layout.lineCount - 1)
            fm.top = fm.ascent
            fm.descent = metrics.descent
            fm.bottom = metrics.bottom
        }
        return layout.width
    }

    override fun draw(canvas: Canvas, text: CharSequence?, start: Int, end: Int, x: Float, top: Int, y: Int, bottom: Int, paint: Paint) {
        remember(paint)
        val layout = layoutFor(paint)
        val save = canvas.save()
        canvas.translate(x, (y - layout.getLineBaseline(layout.lineCount - 1)).toFloat())
        layout.draw(canvas)
        underline.color = this.text.color
        for (line in 0 until layout.lineCount) {
            val lineY = layout.getLineBaseline(line) + look.dp(2.5f)
            canvas.drawLine(layout.getLineLeft(line), lineY, layout.getLineRight(line), lineY, underline)
        }
        canvas.restoreToCount(save)
    }
}
