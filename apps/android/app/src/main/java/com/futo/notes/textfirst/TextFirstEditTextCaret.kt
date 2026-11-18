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

/** The platform caret, cut to the font ascent and descent of the text at the caret; in code, to body text's. */
private class TextHeightCaret(caret: Drawable, private val view: TextFirstEditText) : DrawableWrapper(caret) {
    private val padding = Rect()
    private val paint = TextPaint()

    override fun onBoundsChange(bounds: Rect) {
        val text = textExtentAtCaret()
        if (text == null) { super.onBoundsChange(bounds); return }
        drawable?.getPadding(padding)
        // Kept inside the line's box by moving it, not cutting it, so its height holds (a code line is short for it).
        val wanted = text.first - padding.top..text.last + padding.bottom
        val shift = when {
            wanted.last > bounds.bottom -> bounds.bottom - wanted.last
            wanted.first < bounds.top -> bounds.top - wanted.first
            else -> 0
        }
        val top = maxOf(bounds.top, wanted.first + shift)
        val bottom = minOf(bounds.bottom, wanted.last + shift)
        super.onBoundsChange(Rect(bounds.left, top, bounds.right, maxOf(top, bottom)))
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
        val metrics = paint.fontMetricsInt
        val baseline = layout.getLineBaseline(line)
        if (text.getSpans(at, at + 1, TfCodeBlock::class.java).isEmpty()) return baseline + metrics.ascent..baseline + metrics.descent
        // In code the caret is as tall as in body text, centred on the code (Mason's rule).
        val body = view.paint.fontMetricsInt
        val centre = baseline + (metrics.ascent + metrics.descent) / 2
        val half = (body.descent - body.ascent) / 2
        return centre - half..centre - half + (body.descent - body.ascent)
    }
}
