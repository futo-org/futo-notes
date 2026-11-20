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
import android.text.style.UpdateAppearance

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
            !bold && !italic -> base ?: look.regular
            else -> {
                val weight = (base ?: look.regular).weight
                look.faceForWeight(if (bold) look.boldWeightOver(weight) else weight, italic || base?.isItalic == true)
            }
        }
        paint.typeface = face
        if (code) paint.textSize *= 0.9f
    }

    override fun updateMeasureState(paint: TextPaint) = apply(paint)

    override fun updateDrawState(paint: TextPaint) {
        apply(paint)
        if (strike) paint.isStrikeThruText = true
    }
}

internal class TfHeading(private val look: TextFirstStyle, val level: Int) :
    MetricAffectingSpan(), LineHeightSpan, TfSpan {
    override fun slice(head: Boolean): TfSpan = if (head) this else TfHeading(look, level)

    private val scale = when (level) { 1 -> 1.5f; 2 -> 1.375f; 3 -> 1.25f; 4 -> 1.1875f; 5 -> 1.125f; else -> 1.0625f }
    private val weight = when (level) { 1, 2 -> 700; 3, 4 -> 600; else -> 500 }

    // A retained inline span may run before or after this one: a run it already made heavier than
    // the body's regular face is bold, and the heading makes it heavier than its own weight.
    private fun apply(paint: TextPaint) {
        val base = paint.typeface ?: look.regular
        paint.textSize = look.textSizePx * scale * if (base === look.mono) 0.9f else 1f
        if (base === look.mono) return
        val bold = base.weight > look.regular.weight
        paint.typeface = look.faceForWeight(if (bold) look.boldWeightOver(weight) else weight, base.isItalic)
    }

    override fun updateMeasureState(paint: TextPaint) = apply(paint)
    override fun updateDrawState(paint: TextPaint) = apply(paint)

    /**
     * Every row of an h1 or h2 is 1.25 times its font size tall and every row of an h3 to h6 one body line, whatever
     * runs it mixes (inline code, bold, a link), with its letters as seen (capital tops to descender bottoms) centred in
     * it and no room above or below the heading: space around it is empty lines (Mason). The TextView adds
     * [TextFirstStyle.bodyLineSpacing] below each row afterwards, so that is counted in the row.
     */
    override fun chooseHeight(text: CharSequence, start: Int, end: Int, spanstartv: Int, lineHeight: Int, fm: Paint.FontMetricsInt) {
        fm.ascent = rowTop
        fm.top = rowTop
        fm.descent = rowTop + rowHeight - look.bodyLineSpacing
        fm.bottom = fm.descent
    }

    private val rowHeight = if (level <= 2) kotlin.math.round(ROW_EMS * look.textSizePx * scale).toInt() else look.bodyLineHeight

    /** The row's top from the baseline: half a row above the middle of the heading's capitals and descenders. */
    private val rowTop: Int = run {
        val paint = TextPaint().apply { typeface = look.regular; textSize = look.textSizePx }
        apply(paint)
        val (seenTop, seenBottom) = visibleLineSpan(paint)
        kotlin.math.round((seenTop + seenBottom) / 2f - rowHeight / 2f).toInt()
    }

    private companion object {
        /** An h1's or h2's row pitch, in its own font size. */
        const val ROW_EMS = 1.25f
    }
}

internal class TfQuote(private val look: TextFirstStyle, val depth: Int) :
    CharacterStyle(), LeadingMarginSpan, UpdateAppearance, TfSpan {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = look.mutedColor }

    override fun slice(head: Boolean): TfSpan = if (head) this else TfQuote(look, depth)
    override fun updateDrawState(tp: TextPaint) { tp.color = look.mutedColor }
    override fun getLeadingMargin(first: Boolean) = (look.quoteIndent * depth).toInt()

    override fun drawLeadingMargin(c: Canvas, p: Paint, x: Int, dir: Int, top: Int, baseline: Int, bottom: Int, text: CharSequence, start: Int, end: Int, first: Boolean, layout: Layout?) {
        paint.color = look.mutedColor
        val bar = look.dp(3f)
        for (level in 0 until depth) {
            val (left, right) = leadingSpan(x, dir, level * look.quoteIndent, level * look.quoteIndent + bar)
            c.drawRect(left, top.toFloat(), right, bottom.toFloat(), paint)
        }
    }
}

/**
 * The canvas x that lies [offset] from a paragraph's leading edge [x]. A leading margin is
 * drawn with `dir` 1 for left-to-right (x is its left edge) and -1 for right-to-left (x is
 * its right edge), so the same offsets put markers beside the text in either direction.
 */
internal fun leadingX(x: Int, dir: Int, offset: Float): Float = x + dir * offset

/** The canvas extent between two leading offsets, as (left, right). */
internal fun leadingSpan(x: Int, dir: Int, from: Float, to: Float): Pair<Float, Float> {
    val a = leadingX(x, dir, from)
    val b = leadingX(x, dir, to)
    return minOf(a, b) to maxOf(a, b)
}

internal enum class ListMarker { Bullet, Ordered, Task }

// The own marker column supplies level one. Add three full steps and
// four half steps, then retain a complete marker at the capped body edge.
private fun listLead(look: TextFirstStyle, depth: Int): Float =
    look.listIndent * (depth.coerceIn(0, 3) + (depth - 3).coerceIn(0, 4) * 0.5f)

internal class TfIndent(private val look: TextFirstStyle, val depth: Int) : LeadingMarginSpan, TfSpan {
    override fun slice(head: Boolean): TfSpan = if (head) this else TfIndent(look, depth)
    override fun getLeadingMargin(first: Boolean) = listLead(look, depth).toInt()
    override fun drawLeadingMargin(c: Canvas, p: Paint, x: Int, dir: Int, top: Int, baseline: Int, bottom: Int, text: CharSequence, start: Int, end: Int, first: Boolean, layout: Layout?) = Unit
}

internal class TfList(
    private val look: TextFirstStyle,
    val depth: Int,
    val marker: ListMarker,
    val label: String,
    val checked: Boolean,
    /** This row opens its item (draw the marker); continuation rows only indent. */
    val first: Boolean,
) : CharacterStyle(), LeadingMarginSpan, UpdateAppearance, TfSpan {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    // Keep the nesting step; reserve enough of this item's column for its
    // complete number before TextView clips drawing to the content padding.
    private val markerColumn = if (marker == ListMarker.Ordered) {
        paint.textSize = look.textSizePx
        paint.typeface = look.regular
        val required = paint.measureText(label) + look.dp(5f)
        if (required > look.listIndent) kotlin.math.ceil(required) else look.listIndent
    } else look.listIndent

    private val markerLead = listLead(look, depth)

    override fun slice(head: Boolean): TfSpan = if (head) this else TfList(look, depth, marker, label, checked, false)

    fun sameAs(other: TfList) = depth == other.depth && marker == other.marker && label == other.label && checked == other.checked && first == other.first

    override fun updateDrawState(tp: TextPaint) {
        if (marker == ListMarker.Task && checked) {
            tp.color = look.mutedColor
            tp.isStrikeThruText = true
        }
    }

    override fun getLeadingMargin(first: Boolean) = (markerLead + markerColumn).toInt()

    /** Dynamic selection is painted by the view, outside Layout's cached glyph drawing. */
    fun drawSelectedMargin(c: Canvas, x: Int, dir: Int, top: Float, bottom: Float) {
        val lead = markerLead
        val unit = markerColumn
        paint.color = look.selectionColor
        paint.style = Paint.Style.FILL
        paint.textSize = look.textSizePx
        paint.typeface = look.regular
        val numberStart = if (marker == ListMarker.Ordered) lead + unit - look.dp(5f) - paint.measureText(label) else lead
        // Layout starts the native body highlight at the integer leading margin.
        // A fractional gutter end would blend over its first pixel a second time.
        val (left, right) = leadingSpan(x, dir, minOf(lead, numberStart), getLeadingMargin(true).toFloat())
        c.drawRect(left, top, right, bottom, paint)
    }

    override fun drawLeadingMargin(c: Canvas, p: Paint, x: Int, dir: Int, top: Int, baseline: Int, bottom: Int, text: CharSequence, start: Int, end: Int, first: Boolean, layout: Layout?) {
        if (!first || !this.first) return
        val spanned = text as? Spanned ?: return
        if (spanned.getSpanStart(this) != start) return
        // Offsets below run from the paragraph's leading edge [x] in direction [dir]:
        // an RTL paragraph's markers sit at its right, beside where its text starts.
        val lead = markerLead
        val unit = markerColumn
        paint.color = look.textColor
        paint.textSize = look.textSizePx
        paint.typeface = look.regular
        when (marker) {
            ListMarker.Bullet -> {
                val radius = look.textSizePx * 2.6f / 17f
                val cy = baseline - look.textSizePx * 0.32f
                paint.style = Paint.Style.FILL
                if (depth % 2 == 1) { paint.style = Paint.Style.STROKE; paint.strokeWidth = look.textSizePx * 1.2f / 17f }
                c.drawCircle(leadingX(x, dir, lead + unit * 0.45f), cy, radius, paint)
            }
            ListMarker.Ordered -> {
                // The number ends beside the text, whichever side that is.
                paint.textAlign = if (dir < 0) Paint.Align.LEFT else Paint.Align.RIGHT
                paint.color = look.mutedColor
                c.drawText(label, leadingX(x, dir, lead + unit - look.dp(5f)), baseline.toFloat(), paint)
                paint.textAlign = Paint.Align.LEFT
            }
            ListMarker.Task -> {
                val size = look.textSizePx * 0.95f
                val cy = baseline - look.textSizePx * 0.35f
                val (boxLeft, boxRight) = leadingSpan(x, dir, lead + unit - size - look.dp(6f), lead + unit - look.dp(6f))
                val box = RectF(boxLeft, cy - size / 2, boxRight, cy + size / 2)
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
        background.color = look.surfaceColor
        bar.color = look.borderColor
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

/** Colour only, so typing in a tag never shifts the line (tags.md). */
internal class TfTag(private val look: TextFirstStyle) : CharacterStyle(), UpdateAppearance, TfSpan {
    override fun slice(head: Boolean): TfSpan = if (head) this else TfTag(look)
    override fun updateDrawState(tp: TextPaint) { tp.color = look.linkColor }
}

/** Atoms: one drawn unit whose caret stops are only its two ends (images.md). */
internal interface TfAtom : TfSpan

internal class TfDivider(private val look: TextFirstStyle, private val width: () -> Int) : ReplacementSpan(), TfAtom {
    private val paint = Paint().apply { color = look.borderColor }

    override fun getSize(paint: Paint, text: CharSequence?, start: Int, end: Int, fm: Paint.FontMetricsInt?): Int = width()

    override fun draw(canvas: Canvas, text: CharSequence?, start: Int, end: Int, x: Float, top: Int, y: Int, bottom: Int, paint: Paint) {
        this.paint.color = look.borderColor
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
/** The room above and below a photo's row: half of what its row once had all below it (4 dp and the line spacing). */
private fun photoRowRoom(look: TextFirstStyle): Int = (look.dp(4f).toInt() + look.bodyLineSpacing) / 2

internal class TfImage(
    private val look: TextFirstStyle,
    val destination: String,
    val alt: String,
    val vault: Boolean,
    val remote: Boolean,
    private val maxWidth: () -> Int,
) : ReplacementSpan(), LineHeightSpan, TfAtom {
    @Volatile var bitmap: Bitmap? = null
    var rememberedSize: PhotoSize? = null
    var failed = false
    private val placeholder = Paint().apply { color = look.surfaceColor }

    private companion object {
        val PHOTO_ROW_ENDINGS: String = "\r\n" + TextFirstEditText.END_SENTINEL
    }

    fun drawSize(): Pair<Int, Int> {
        val bmp = bitmap
        val limit = maxOf(1, maxWidth())
        val reserved = rememberedSize.takeUnless { failed }
        val width = bmp?.width ?: reserved?.width
            ?: return limit to if (failed) look.dp(28f).toInt() else look.dp(48f).toInt()
        val height = bmp?.height ?: checkNotNull(reserved).height
        val drawnWidth = minOf(limit, width)
        return drawnWidth to (height.toLong() * drawnWidth / width).toInt()
    }

    override fun getSize(paint: Paint, text: CharSequence?, start: Int, end: Int, fm: Paint.FontMetricsInt?): Int {
        val (w, h) = drawSize()
        if (fm != null) {
            // Sharing its row (text, another photo), the photo takes only its own height; alone, chooseHeight sets the row.
            fm.ascent = -h
            fm.top = fm.ascent
            fm.descent = look.dp(4f).toInt()
            fm.bottom = fm.descent
        }
        return w
    }

    /**
     * A photo alone on its row owns the row: as much room above the photo as below it (the line break's own font would
     * otherwise set the room below). The TextView adds the line spacing below the row, so it is counted in.
     */
    override fun chooseHeight(text: CharSequence, start: Int, end: Int, spanstartv: Int, lineHeight: Int, fm: Paint.FontMetricsInt) {
        val spanned = text as? Spanned ?: return
        if (!fillsPhotoRow(spanned, start, end)) return
        val h = drawSize().second
        fm.ascent = -h - photoRowRoom(look)
        fm.top = fm.ascent
        // The note's last row gets no line spacing from the TextView.
        fm.descent = photoRowRoom(look) - if (end >= text.length) 0 else look.bodyLineSpacing
        fm.bottom = fm.descent
    }

    fun fillsPhotoRow(text: Spanned, start: Int, end: Int): Boolean {
        var contentEnd = end
        while (contentEnd > start && text[contentEnd - 1] in PHOTO_ROW_ENDINGS) contentEnd--
        return text.getSpanStart(this) == start && text.getSpanEnd(this) == contentEnd
    }

    override fun draw(canvas: Canvas, text: CharSequence?, start: Int, end: Int, x: Float, top: Int, y: Int, bottom: Int, paint: Paint) {
        val (w, h) = drawSize()
        val bmp = bitmap
        val rect = RectF(x, (y - h).toFloat(), x + w, y.toFloat())
        if (bmp != null) {
            canvas.drawBitmap(bmp, null, rect, null)
        } else {
            placeholder.color = look.surfaceColor
            canvas.drawRoundRect(rect, look.dp(6f), look.dp(6f), placeholder)
            if (failed) {
                val p = TextPaint(paint).apply { color = look.mutedColor; textSize = look.textSizePx * 0.8f }
                canvas.drawText(alt.ifEmpty { destination }, x + look.dp(8f), y - h / 2f + p.textSize / 3, p)
            }
        }
    }
}

/** Inline and atom spans never grow with typed text; block spans also cover provisional input. */
internal const val TF_SPAN_FLAGS = Spanned.SPAN_EXCLUSIVE_EXCLUSIVE
