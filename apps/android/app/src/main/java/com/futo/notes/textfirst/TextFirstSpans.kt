package com.futo.notes.textfirst

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Typeface
import android.text.Layout
import android.text.Spanned
import android.text.TextPaint
import android.text.style.CharacterStyle
import android.text.style.LeadingMarginSpan
import android.text.style.LineBackgroundSpan
import android.text.style.LineHeightSpan
import android.text.style.MetricAffectingSpan
import android.text.style.ReplacementSpan
import android.text.style.UpdateLayout
import android.text.style.UpdateAppearance

/**
 * The look of the text-first editor, matched to the Milkdown surface
 * (milkdownEditor.surface.css): 17px Barlow at 1.55 line height, headings at
 * 1.7/1.4/1.2em weight 650, muted quotes behind a 3px rule, monospace code at
 * 0.9em on the code background. Pixel values are resolved once per view.
 */
internal class TextFirstStyle(
    val density: Float,
    val textSizePx: Float,
    val regular: Typeface,
    val semibold: Typeface,
    val bold: Typeface,
    val mono: Typeface,
    val textColor: Int,
    val mutedColor: Int,
    val linkColor: Int,
    val borderColor: Int,
    val codeBackground: Int,
    val surfaceColor: Int,
    val italic: Typeface = regular,
    val boldItalic: Typeface = bold,
) {
    fun dp(value: Float) = value * density
    val listIndent = textSizePx * 1.4f
    val quoteIndent = dp(3f) + textSizePx * 0.9f
    val codePadding = dp(12f)

    /** Find-match highlight: the link colour, stronger for the current match. */
    fun findMarkColor(current: Boolean) = (linkColor and 0x00ffffff) or (if (current) 0x99000000.toInt() else 0x40000000)
}

/** Every span the renderer owns; anything else on the Editable belongs to the platform or the IME. */
internal interface TfSpan {
    /**
     * This span for the part of its range outside a restyled window: the head
     * (before the window) may reuse this object, the tail needs a copy. Null
     * drops that part (atoms are never split).
     */
    fun slice(head: Boolean): TfSpan? = if (head) this else null
}

internal class TfInline(
    private val look: TextFirstStyle,
    val bold: Boolean,
    val italic: Boolean,
    val strike: Boolean,
    val code: Boolean,
) : MetricAffectingSpan(), TfSpan {
    override fun slice(head: Boolean): TfSpan = if (head) this else TfInline(look, bold, italic, strike, code)

    private fun apply(paint: TextPaint) {
        val base = paint.typeface
        // Real Barlow Italic / Bold Italic: the platform's synthetic slant (and any skew of our own)
        // pushed glyphs past their advance, so the caret overlapped them. Code stays upright.
        val face = when {
            code -> look.mono
            italic && (bold || base === look.semibold) -> look.boldItalic
            italic -> look.italic
            bold -> look.bold
            else -> base ?: look.regular
        }
        paint.typeface = face
        if (code) paint.textSize *= 0.9f
    }

    override fun updateMeasureState(paint: TextPaint) = apply(paint)

    override fun updateDrawState(paint: TextPaint) {
        apply(paint)
        if (strike) paint.isStrikeThruText = true
        if (code) paint.bgColor = look.codeBackground
    }
}

internal class TfHeading(private val look: TextFirstStyle, val level: Int) :
    MetricAffectingSpan(), LineHeightSpan, TfSpan {
    override fun slice(head: Boolean): TfSpan = if (head) this else TfHeading(look, level)

    private val scale = when (level) { 1 -> 1.7f; 2 -> 1.4f; 3 -> 1.2f; else -> 1.05f }

    private fun apply(paint: TextPaint) {
        paint.textSize = look.textSizePx * scale
        paint.typeface = look.semibold
    }

    override fun updateMeasureState(paint: TextPaint) = apply(paint)
    override fun updateDrawState(paint: TextPaint) = apply(paint)

    // CSS margin-top: 1.2em above a heading — but not when it opens the note.
    override fun chooseHeight(text: CharSequence, start: Int, end: Int, spanstartv: Int, lineHeight: Int, fm: Paint.FontMetricsInt) {
        val spanStart = (text as Spanned).getSpanStart(this)
        if (start != spanStart || spanStart == 0) return
        val extra = (look.textSizePx * 0.6f).toInt()
        fm.ascent -= extra
        fm.top -= extra
    }
}

internal class TfQuote(private val look: TextFirstStyle, val depth: Int) :
    CharacterStyle(), LeadingMarginSpan, UpdateAppearance, TfSpan {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = look.mutedColor }

    override fun slice(head: Boolean): TfSpan = if (head) this else TfQuote(look, depth)
    override fun updateDrawState(tp: TextPaint) { tp.color = look.mutedColor }
    override fun getLeadingMargin(first: Boolean) = (look.quoteIndent * depth).toInt()

    override fun drawLeadingMargin(c: Canvas, p: Paint, x: Int, dir: Int, top: Int, baseline: Int, bottom: Int, text: CharSequence, start: Int, end: Int, first: Boolean, layout: Layout?) {
        val bar = look.dp(3f)
        for (level in 0 until depth) {
            val left = x + dir * level * look.quoteIndent
            c.drawRect(left, top.toFloat(), left + dir * bar, bottom.toFloat(), paint)
        }
    }
}

internal enum class ListMarker { Bullet, Ordered, Task }

internal class TfList(
    private val look: TextFirstStyle,
    val depth: Int,
    val marker: ListMarker,
    val number: Long?,
    val checked: Boolean,
    /** This row opens its item (draw the marker); continuation rows only indent. */
    val first: Boolean,
) : CharacterStyle(), LeadingMarginSpan, UpdateAppearance, TfSpan {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)

    override fun slice(head: Boolean): TfSpan = if (head) this else TfList(look, depth, marker, number, checked, false)

    fun sameAs(other: TfList) = depth == other.depth && marker == other.marker && number == other.number && checked == other.checked && first == other.first

    override fun updateDrawState(tp: TextPaint) {
        if (marker == ListMarker.Task && checked) {
            tp.color = look.mutedColor
            tp.isStrikeThruText = true
        }
    }

    override fun getLeadingMargin(first: Boolean) = (look.listIndent * (depth + 1)).toInt()

    /** The marker's box in layout coordinates, for hit-testing a checkbox tap. */
    fun markerLeft(x: Int) = x + look.listIndent * depth

    override fun drawLeadingMargin(c: Canvas, p: Paint, x: Int, dir: Int, top: Int, baseline: Int, bottom: Int, text: CharSequence, start: Int, end: Int, first: Boolean, layout: Layout?) {
        if (!first || !this.first) return
        val spanned = text as? Spanned ?: return
        if (spanned.getSpanStart(this) != start) return
        val left = markerLeft(x)
        val unit = look.listIndent
        paint.color = look.textColor
        paint.textSize = look.textSizePx
        paint.typeface = look.regular
        when (marker) {
            ListMarker.Bullet -> {
                val radius = look.dp(2.6f)
                val cy = baseline - look.textSizePx * 0.32f
                paint.style = Paint.Style.FILL
                if (depth % 2 == 1) { paint.style = Paint.Style.STROKE; paint.strokeWidth = look.dp(1.2f) }
                c.drawCircle(left + unit * 0.45f, cy, radius, paint)
            }
            ListMarker.Ordered -> {
                paint.textAlign = Paint.Align.RIGHT
                paint.color = look.mutedColor
                c.drawText("${number ?: 1}.", left + unit - look.dp(5f), baseline.toFloat(), paint)
                paint.textAlign = Paint.Align.LEFT
            }
            ListMarker.Task -> {
                val size = look.textSizePx * 0.95f
                val cy = baseline - look.textSizePx * 0.35f
                val box = RectF(left + unit - size - look.dp(6f), cy - size / 2, left + unit - look.dp(6f), cy + size / 2)
                paint.strokeWidth = look.dp(1.5f)
                if (checked) {
                    paint.style = Paint.Style.FILL
                    paint.color = look.linkColor
                    c.drawRoundRect(box, look.dp(3f), look.dp(3f), paint)
                    paint.style = Paint.Style.STROKE
                    paint.color = 0xFFFFFFFF.toInt()
                    paint.strokeWidth = look.dp(2f)
                    c.drawLine(box.left + size * 0.22f, cy, box.left + size * 0.42f, cy + size * 0.2f, paint)
                    c.drawLine(box.left + size * 0.42f, cy + size * 0.2f, box.right - size * 0.2f, cy - size * 0.22f, paint)
                } else {
                    paint.style = Paint.Style.STROKE
                    paint.color = look.mutedColor
                    c.drawRoundRect(box, look.dp(3f), look.dp(3f), paint)
                }
                paint.style = Paint.Style.FILL
            }
        }
    }

    /** The checkbox's horizontal extent relative to the line's leading edge. */
    fun checkboxHit(lineLeft: Float, x: Float): Boolean {
        if (marker != ListMarker.Task) return false
        val right = lineLeft + look.listIndent * (depth + 1)
        return x >= right - look.listIndent - look.dp(8f) && x <= right + look.dp(4f)
    }
}

/**
 * A code line's monospace face and inset. Its background is not a
 * LineBackgroundSpan: the TextView draws the caret before the layout's line
 * backgrounds, so an opaque one would cover the caret on a code line. The view
 * paints it first instead (`drawCodeBackgrounds`).
 */
internal class TfCodeBlock(private val look: TextFirstStyle) :
    MetricAffectingSpan(), LeadingMarginSpan, TfSpan {
    override fun slice(head: Boolean): TfSpan = if (head) this else TfCodeBlock(look)

    override fun updateMeasureState(paint: TextPaint) {
        paint.typeface = look.mono
        paint.textSize = look.textSizePx * 0.85f
    }

    override fun updateDrawState(paint: TextPaint) = updateMeasureState(paint)

    override fun getLeadingMargin(first: Boolean) = look.codePadding.toInt()
    override fun drawLeadingMargin(c: Canvas, p: Paint, x: Int, dir: Int, top: Int, baseline: Int, bottom: Int, text: CharSequence, start: Int, end: Int, first: Boolean, layout: Layout?) = Unit
}

internal class TfMetadata(private val look: TextFirstStyle) :
    MetricAffectingSpan(), LineBackgroundSpan, LeadingMarginSpan, TfSpan {
    private val background = Paint().apply { color = look.surfaceColor }
    private val bar = Paint().apply { color = look.borderColor }

    override fun slice(head: Boolean): TfSpan = if (head) this else TfMetadata(look)

    override fun updateMeasureState(paint: TextPaint) {
        paint.typeface = look.mono
        paint.textSize = look.textSizePx * 0.85f
    }

    override fun updateDrawState(paint: TextPaint) {
        updateMeasureState(paint)
        paint.color = look.mutedColor
    }

    override fun drawBackground(c: Canvas, p: Paint, left: Int, right: Int, top: Int, baseline: Int, bottom: Int, text: CharSequence, start: Int, end: Int, lineNumber: Int) {
        c.drawRect(left.toFloat(), top.toFloat(), right.toFloat(), bottom.toFloat(), background)
        c.drawRect(left.toFloat(), top.toFloat(), left + look.dp(3f), bottom.toFloat(), bar)
    }

    override fun getLeadingMargin(first: Boolean) = look.codePadding.toInt()
    override fun drawLeadingMargin(c: Canvas, p: Paint, x: Int, dir: Int, top: Int, baseline: Int, bottom: Int, text: CharSequence, start: Int, end: Int, first: Boolean, layout: Layout?) = Unit
}

internal class TfLink(private val look: TextFirstStyle, val destination: String) : CharacterStyle(), UpdateAppearance, TfSpan {
    override fun slice(head: Boolean): TfSpan = if (head) this else TfLink(look, destination)

    override fun updateDrawState(tp: TextPaint) {
        tp.color = look.linkColor
        tp.isUnderlineText = true
    }
}

/** Atoms: one drawn unit whose caret stops are only its two ends (images.md). */
internal interface TfAtom : TfSpan

internal class TfDivider(private val look: TextFirstStyle, private val width: () -> Int) : ReplacementSpan(), TfAtom {
    private val paint = Paint().apply { color = look.borderColor }

    override fun getSize(paint: Paint, text: CharSequence?, start: Int, end: Int, fm: Paint.FontMetricsInt?): Int = width()

    override fun draw(canvas: Canvas, text: CharSequence?, start: Int, end: Int, x: Float, top: Int, y: Int, bottom: Int, paint: Paint) {
        val mid = (top + bottom) / 2f
        canvas.drawRect(x, mid - look.dp(0.5f), x + width(), mid + look.dp(0.5f), this.paint)
    }
}

/**
 * An image atom. Until its bitmap decodes it reserves a short placeholder row
 * (images.md: an unresolved vault image renders as nothing, then resolves in
 * place); the view re-sets the span when the bitmap lands, which re-lays out
 * only this paragraph.
 */
internal class TfImage(
    private val look: TextFirstStyle,
    val destination: String,
    val alt: String,
    val vault: Boolean,
    val remote: Boolean,
    private val maxWidth: () -> Int,
) : ReplacementSpan(), TfAtom {
    @Volatile var bitmap: Bitmap? = null
    var failed = false
    private val placeholder = Paint().apply { color = look.surfaceColor }

    private fun drawSize(): Pair<Int, Int> {
        val bmp = bitmap
        val limit = maxOf(1, maxWidth())
        if (bmp == null) return limit to if (failed) look.dp(28f).toInt() else look.dp(48f).toInt()
        val w = minOf(limit, bmp.width)
        return w to (bmp.height.toLong() * w / maxOf(1, bmp.width)).toInt()
    }

    override fun getSize(paint: Paint, text: CharSequence?, start: Int, end: Int, fm: Paint.FontMetricsInt?): Int {
        val (w, h) = drawSize()
        if (fm != null) {
            fm.ascent = -h
            fm.top = -h
            fm.descent = look.dp(4f).toInt()
            fm.bottom = fm.descent
        }
        return w
    }

    override fun draw(canvas: Canvas, text: CharSequence?, start: Int, end: Int, x: Float, top: Int, y: Int, bottom: Int, paint: Paint) {
        val (w, h) = drawSize()
        val bmp = bitmap
        val rect = RectF(x, (y - h).toFloat(), x + w, y.toFloat())
        if (bmp != null) {
            canvas.drawBitmap(bmp, null, rect, null)
        } else {
            canvas.drawRoundRect(rect, look.dp(6f), look.dp(6f), placeholder)
            if (failed) {
                val p = TextPaint(paint).apply { color = look.mutedColor; textSize = look.textSizePx * 0.8f }
                canvas.drawText(alt.ifEmpty { destination }, x + look.dp(8f), y - h / 2f + p.textSize / 3, p)
            }
        }
    }
}

/** The Editable flags every renderer span uses: never grow with typed text. */
internal const val TF_SPAN_FLAGS = Spanned.SPAN_EXCLUSIVE_EXCLUSIVE

/**
 * A blank display line between blocks, drawn at half height to stand in for
 * the Milkdown surface's 0.75em block gap. One per blank line: a LineHeightSpan
 * is also a WrapTogetherSpan, so a span over more than its own line would make
 * the layout reflow everything it covers on every edit (it did: a whole-note
 * span cost 6 s a keystroke in a 19k-line note). [UpdateLayout] so that adding
 * it to text already laid out (a streamed slice) re-measures its line: a
 * bare LineHeightSpan is only consulted when the line is next broken.
 */
internal class TfBlankLine : LineHeightSpan, UpdateLayout, TfSpan {
    override fun slice(head: Boolean): TfSpan? = null

    override fun chooseHeight(text: CharSequence, start: Int, end: Int, spanstartv: Int, lineHeight: Int, fm: Paint.FontMetricsInt) {
        val empty = end - start == 1 && text[start] == '\n' && start > 0
        if (!empty) return
        val height = fm.descent - fm.ascent
        val target = (height * 0.5f).toInt()
        fm.ascent = fm.descent - target
        fm.top = fm.ascent
        fm.bottom = fm.descent
    }
}
