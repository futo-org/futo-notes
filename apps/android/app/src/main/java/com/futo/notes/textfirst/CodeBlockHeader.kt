package com.futo.notes.textfirst

import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import android.text.TextPaint
import android.text.TextUtils

/**
 * A block's header row, [top] to [top] + its height across [width]: the `name:` at the left in
 * monospace, the language and a copy glyph at the right. Both texts shrink with an ellipsis
 * before they collide, the name first.
 */
internal class CodeBlockHeader(private val look: TextFirstStyle) {
    private val namePaint = TextPaint(Paint.ANTI_ALIAS_FLAG)
    private val languagePaint = TextPaint(Paint.ANTI_ALIAS_FLAG)
    private val glyphPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }
    private val glyphBox = RectF()

    /** The copy glyph's box in the header drawn last, in the canvas's coordinates. */
    val copyTarget = RectF()

    fun draw(canvas: Canvas, block: CodeBlockFacts, width: Float, top: Float) {
        namePaint.typeface = look.mono
        namePaint.textSize = look.codeHeaderTextSize
        namePaint.color = look.mutedColor
        languagePaint.typeface = look.regular
        languagePaint.textSize = look.codeHeaderTextSize
        languagePaint.color = look.mutedColor
        val metrics = languagePaint.fontMetrics
        val baseline = top + (look.codeHeaderHeight - metrics.ascent - metrics.descent) / 2f
        val glyph = look.codeHeaderTextSize
        val glyphRight = width - look.codeCorner
        val glyphLeft = glyphRight - glyph
        drawCopyGlyph(canvas, glyphLeft, top + (look.codeHeaderHeight - glyph) / 2f, glyph)
        copyTarget.set(glyphLeft - look.codeChipPad, top, width, top + look.codeHeaderHeight)
        val room = glyphLeft - look.codeChipPad - look.codeCorner
        var languageLeft = glyphLeft - look.codeChipPad
        block.language?.takeIf { it.isNotEmpty() }?.let { language ->
            val shown = TextUtils.ellipsize(language, languagePaint, room / 2f, TextUtils.TruncateAt.END)
            languageLeft -= languagePaint.measureText(shown, 0, shown.length)
            canvas.drawText(shown, 0, shown.length, languageLeft, baseline, languagePaint)
            languageLeft -= look.codeChipPad
        }
        block.name?.takeIf { it.isNotEmpty() }?.let { name ->
            val shown = TextUtils.ellipsize(name, namePaint, languageLeft - look.codeCorner, TextUtils.TruncateAt.END)
            canvas.drawText(shown, 0, shown.length, look.codeCorner, baseline, namePaint)
        }
    }

    /** Two overlapping rounded squares, the usual copy mark, [size] square at ([left], [top]). */
    private fun drawCopyGlyph(canvas: Canvas, left: Float, top: Float, size: Float) {
        glyphPaint.color = look.mutedColor
        glyphPaint.strokeWidth = size / 11f
        val square = size * 0.68f
        val corner = size * 0.12f
        glyphBox.set(left, top, left + square, top + square)
        canvas.drawRoundRect(glyphBox, corner, corner, glyphPaint)
        glyphBox.set(left + size - square, top + size - square, left + size, top + size)
        canvas.drawRoundRect(glyphBox, corner, corner, glyphPaint)
    }
}
