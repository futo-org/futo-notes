package com.futo.notes.textfirst

import android.graphics.Paint
import android.graphics.Rect
import android.text.TextPaint
import android.text.style.LineHeightSpan
import kotlin.math.roundToInt

/**
 * The field's one line, as tall as the font's but centred on what the eye sees, from the capitals'
 * top to the descenders' bottom, so the selection highlight sits around the text instead of
 * reaching mostly above it (Mason, 2026-11-17: "magnetized to the top").
 */
internal class CentredLine(paint: TextPaint) : LineHeightSpan {
    val ascent: Int
    val descent: Int

    init {
        val metrics = paint.fontMetricsInt
        val capital = Rect().also { paint.getTextBounds("H", 0, 1, it) }
        val height = metrics.descent - metrics.ascent
        val centre = (capital.top + metrics.descent) / 2f
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

