package com.futo.notes.textfirst

import android.graphics.Paint
import android.graphics.Rect
import android.text.TextPaint
import android.text.style.LineHeightSpan
import kotlin.math.roundToInt

/**
 * The field's one line, as tall as the font's but centred on what the eye sees ([visibleLineSpan]),
 * so the selection highlight sits around the text: not mostly above it (Mason, 2026-11-17:
 * "magnetized to the top"), nor below it, as the font's declared descent put it (job 11 C).
 */
internal class CentredLine(paint: TextPaint) : LineHeightSpan {
    val ascent: Int
    val descent: Int

    init {
        val metrics = paint.fontMetricsInt
        val (top, bottom) = visibleLineSpan(paint)
        val height = metrics.descent - metrics.ascent
        val centre = (top + bottom) / 2f
        ascent = (centre - height / 2f).roundToInt()
        descent = ascent + height
    }

    override fun chooseHeight(text: CharSequence, start: Int, end: Int, spanstartv: Int, lineHeight: Int, fm: Paint.FontMetricsInt) {
        fm.ascent = ascent
        fm.top = ascent
        fm.descent = descent
        fm.bottom = descent
    }
}

/** What the eye sees of a line in [paint], relative to its baseline: from the capitals' top to the descenders' drawn bottom. */
internal fun visibleLineSpan(paint: Paint): Pair<Int, Int> = visibleLetters(paint).span

/**
 * How far below the middle of [paint]'s font box (ascent to descent) the middle of its letters as seen lies: a box
 * centred by its font box carries its text this much low.
 */
internal fun lettersBelowFontBoxCentre(paint: Paint): Float = visibleLetters(paint).belowFontBoxCentre

private class VisibleLetters(val span: Pair<Int, Int>, val belowFontBoxCentre: Float)

/** Measured once per face and size: overlays and chips ask on every frame, for every row they draw. */
private val lettersByFaceAndSize = android.util.LongSparseArray<VisibleLetters>()

private fun visibleLetters(paint: Paint): VisibleLetters = synchronized(lettersByFaceAndSize) {
    val key = (System.identityHashCode(paint.typeface).toLong() shl 32) or (paint.textSize.toRawBits().toLong() and 0xffffffffL)
    lettersByFaceAndSize.get(key) ?: run {
        val capital = Rect().also { paint.getTextBounds("H", 0, 1, it) }
        val descender = Rect().also { paint.getTextBounds("gjpqy", 0, 5, it) }
        val font = paint.fontMetrics
        VisibleLetters(capital.top to descender.bottom, (capital.top + descender.bottom) / 2f - (font.ascent + font.descent) / 2f)
    }.also { lettersByFaceAndSize.put(key, it) }
}
