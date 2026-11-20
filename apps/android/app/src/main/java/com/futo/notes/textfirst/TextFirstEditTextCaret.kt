package com.futo.notes.textfirst

import android.graphics.Rect
import android.graphics.drawable.Drawable
import android.graphics.drawable.DrawableWrapper
import android.os.Build
import android.text.TextPaint
import android.text.style.MetricAffectingSpan

/**
 * TextView draws the caret from its line's top, so on a line a span makes taller than its text
 * (an h1's two body lines, a code block's label header) the caret would cover that extra height.
 * Android 9 has no cursor drawable setter and keeps the platform caret. Call it before the caret is
 * tinted: TextView keeps the first cursor drawable it loads, so a later one would never draw.
 */
internal fun TextFirstEditText.fitCaretToItsText() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return
    val platformCaret = textCursorDrawable ?: return
    textCursorDrawable = TextHeightCaret(platformCaret, this)
}

/**
 * The platform caret, as tall as the font's ascent to descent at the caret (in code, body text's) and centred on the
 * text as seen, capital tops to descender bottoms: the font's ascent reaches far above its capitals and its descent
 * barely below its descenders, so a caret on them sat high against the letters (Mason, S23). Beside a photo taller
 * than that, it is as tall as the photo, as on desktop.
 */
private class TextHeightCaret(caret: Drawable, private val view: TextFirstEditText) : DrawableWrapper(caret) {
    private val padding = Rect()
    private val paint = TextPaint()
    private val photo = Rect()
    private val drawn = android.graphics.RectF()
    /** Beside a photo: the TextView draws its caret clipped to its text and under it, so the note draws it after all. */
    private var besidePhoto = false
    private var dueOverPhoto = false

    override fun draw(canvas: android.graphics.Canvas) {
        if (besidePhoto) dueOverPhoto = true else super.draw(canvas)
    }

    /** The caret the platform asked for this frame beside a photo, drawn over the note ([drawCaretBesidePhoto]). */
    fun drawDue(canvas: android.graphics.Canvas) {
        if (!dueOverPhoto) return
        dueOverPhoto = false
        val save = canvas.save()
        canvas.translate(view.totalPaddingLeft.toFloat(), view.totalPaddingTop.toFloat())
        drawable?.draw(canvas)
        canvas.restoreToCount(save)
    }

    override fun onBoundsChange(bounds: Rect) {
        val layout = view.layout
        val text = textExtentAtCaret()
        if (text == null || layout == null) { besidePhoto = false; super.onBoundsChange(bounds); return }
        drawable?.getPadding(padding)
        val line = layout.getLineForOffset(view.selectionStart)
        val beside = photoBesideCaret(layout, view.editableText, view.selectionStart, line)
        besidePhoto = beside != null
        val extent = if (beside != null && photo.height() > text.last - text.first) photo.top..photo.bottom else text
        // Kept inside its row, line spacing included (the platform's bounds leave it out): too tall for it, it is cut
        // the same at both ends, so it stays centred on the letters.
        val row = layout.getLineTop(line)..layout.getLineBottom(line)
        val over = maxOf(0, row.first - extent.first, extent.last - row.last)
        val top = extent.first + over - padding.top
        val bottom = extent.last - over + padding.bottom
        // Just outside the photo's edge, on the side it touches.
        val half = (bounds.width() - padding.left - padding.right + 1) / 2
        val dx = when {
            beside == null -> 0
            bounds.centerX() <= photo.centerX() -> photo.left - half - bounds.centerX()
            else -> photo.right + half - bounds.centerX()
        }
        super.onBoundsChange(Rect(bounds.left + dx, top, bounds.right + dx, maxOf(top, bottom)))
    }

    /** Layout coordinates, as TextView sets the caret's bounds. */
    private fun textExtentAtCaret(): IntRange? {
        val layout = view.layout ?: return null
        val text = view.editableText ?: return null
        val offset = view.selectionStart
        if (offset < 0) return null
        val line = layout.getLineForOffset(offset)
        val lineStart = layout.getLineStart(line)
        val at = offset.coerceIn(lineStart, maxOf(lineStart, layout.getLineEnd(line) - 1))
        paint.set(view.paint)
        for (span in text.getSpans(at, at + 1, MetricAffectingSpan::class.java)) span.updateMeasureState(paint)
        val metrics = if (text.getSpans(at, at + 1, TfCodeBlock::class.java).isEmpty()) paint.fontMetricsInt else view.paint.fontMetricsInt
        val height = metrics.descent - metrics.ascent
        val (seenTop, seenBottom) = visibleLineSpan(paint)
        val top = layout.getLineBaseline(line) + (seenTop + seenBottom - height) / 2
        return top..top + height
    }

    /**
     * The tallest loaded photo the caret touches on its own row, its drawn rect put in [photo] (layout coordinates);
     * null with none. A photo still loading is not one: beside its placeholder the caret stays one text line tall.
     */
    private fun photoBesideCaret(layout: android.text.Layout, text: android.text.Spanned, offset: Int, line: Int): TfImage? {
        var tallest: TfImage? = null
        for (image in text.getSpans(maxOf(0, offset - 1), minOf(text.length, offset + 1), TfImage::class.java)) {
            val start = text.getSpanStart(image)
            if (start != offset && text.getSpanEnd(image) != offset) continue
            if (image.bitmap == null || layout.getLineForOffset(start) != line) continue
            if (tallest != null && image.drawSize().second <= photo.height()) continue
            if (!imageDrawnRect(layout, text, image, drawn)) continue
            drawn.roundOut(photo)
            tallest = image
        }
        return tallest
    }
}

/** The caret beside a photo, which the TextView left for the note to draw over everything (TextHeightCaret). */
internal fun TextFirstEditText.drawCaretBesidePhoto(canvas: android.graphics.Canvas) {
    (textCursorDrawable as? TextHeightCaret)?.drawDue(canvas)
}
