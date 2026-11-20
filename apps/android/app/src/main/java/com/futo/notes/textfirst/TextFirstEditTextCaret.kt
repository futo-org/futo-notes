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
 * barely below its descenders, so a caret on them sat high against the letters (Mason, S23).
 */
private class TextHeightCaret(caret: Drawable, private val view: TextFirstEditText) : DrawableWrapper(caret) {
    private val padding = Rect()
    private val paint = TextPaint()
    private val visible = Rect()

    override fun onBoundsChange(bounds: Rect) {
        val layout = view.layout
        val text = textExtentAtCaret()
        if (text == null || layout == null) { super.onBoundsChange(bounds); return }
        drawable?.getPadding(padding)
        // Kept inside its row, line spacing included (the platform's bounds leave it out), by moving it, not cutting
        // it, so its height holds (a code line is short for it).
        val line = layout.getLineForOffset(view.selectionStart)
        val row = layout.getLineTop(line) - padding.top..layout.getLineBottom(line) + padding.bottom
        val wanted = text.first - padding.top..text.last + padding.bottom
        val shift = when {
            wanted.last > row.last -> row.last - wanted.last
            wanted.first < row.first -> row.first - wanted.first
            else -> 0
        }
        val top = maxOf(row.first, wanted.first + shift)
        val bottom = minOf(row.last, wanted.last + shift)
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
        val metrics = if (text.getSpans(at, at + 1, TfCodeBlock::class.java).isEmpty()) paint.fontMetricsInt else view.paint.fontMetricsInt
        val height = metrics.descent - metrics.ascent
        paint.getTextBounds(VISIBLE_EXTENT, 0, VISIBLE_EXTENT.length, visible)
        val top = layout.getLineBaseline(line) + (visible.top + visible.bottom - height) / 2
        return top..top + height
    }
}

/** A capital and a descender: the text as seen reaches from the one's top to the other's bottom. */
private const val VISIBLE_EXTENT = "Hg"
