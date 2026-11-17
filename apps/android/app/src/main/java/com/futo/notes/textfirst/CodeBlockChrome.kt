package com.futo.notes.textfirst

import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import android.text.TextPaint
import android.text.TextUtils

/** What a press on a drawn part of a code block does. */
internal enum class CodeBlockAction { SELECT_BLOCK, NAME_FIELD, LANGUAGE_LABEL, COPY_CODE, OPEN_LINE_ABOVE, OPEN_LINE_BELOW, NOTHING }

/** One block's header as drawn: [active] when the caret or the selection is in the block. */
internal class CodeHeaderState(val block: CodeBlockFacts, val codeStart: Int, val width: Float, val top: Float, val lineAbove: Boolean, val active: Boolean)

/** One pressable part of a drawn block, in layout coordinates; [codeStart] is where the block's code starts. */
internal class CodeBlockTarget(val area: RectF, val action: CodeBlockAction, val codeStart: Int, val block: CodeBlockFacts? = null)

/** The catalog's words for a block's "add a line" affordances. */
internal data class CodeBlockLabels(val addLineAbove: String, val addLineBelow: String, val namePlaceholder: String, val languagePlaceholder: String)

/**
 * What a block draws around its code: the header row (the `name:` at the left in monospace, the
 * language and a copy glyph at the right, "add a line above" in the room the name leaves between
 * them, as in !300) and "add a line below" in the skirt. The texts shrink with an ellipsis before
 * they collide: the label first, then the name, the language last.
 * Each part drawn is recorded as a [CodeBlockTarget], so a press finds exactly what it landed on.
 */
internal class CodeBlockChrome(private val look: TextFirstStyle) {
    private val namePaint = TextPaint(Paint.ANTI_ALIAS_FLAG)
    private val languagePaint = TextPaint(Paint.ANTI_ALIAS_FLAG)
    private val edgePaint = TextPaint(Paint.ANTI_ALIAS_FLAG)
    private val glyphPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }
    private val glyphBox = RectF()
    private val targets = ArrayList<CodeBlockTarget>()

    var labels = CodeBlockLabels("", "", "", "")
    /** The selection a block owns the paint of (CodeSelectionPaint). */
    var selection: CodeSelectionPaint? = null
    /** The view's last reported selection ends, to tell which end a handle moved. */
    var lastStart = -1
    var lastEnd = -1
    /** The block and field a CodeHeaderField has open; that field's text is the field's to show. */
    var openField: Pair<Int, CodeHeaderField.Kind>? = null
    /** The code start of the block whose copy glyph shows a checkmark, -1 for none. */
    var copiedBlock = -1

    fun clearTargets() = targets.clear()

    /** The topmost part drawn at ([x], [y]) in layout coordinates. */
    fun targetAt(x: Float, y: Float): CodeBlockTarget? = targets.lastOrNull { it.area.contains(x, y) }

    /**
     * The name at the left, the chip (language, or the ghost "language" while the block is active,
     * and the copy glyph) at the right. The chip's box is the same whether or not the ghost is inked
     * (!300 cb 630-637), and an empty name keeps a box too, so a press never lands on a target
     * that grows under it.
     */
    fun drawHeader(canvas: Canvas, header: CodeHeaderState) {
        val block = header.block
        val codeStart = header.codeStart
        val width = header.width
        val top = header.top
        namePaint.typeface = look.mono
        namePaint.textSize = look.codeHeaderTextSize
        namePaint.color = look.mutedColor
        languagePaint.typeface = look.regular
        languagePaint.textSize = look.codeHeaderTextSize
        languagePaint.color = look.mutedColor
        val bottom = top + look.codeHeaderHeight
        targets.add(CodeBlockTarget(RectF(0f, top, width, bottom), CodeBlockAction.SELECT_BLOCK, codeStart, block))
        val metrics = languagePaint.fontMetrics
        val baseline = top + (look.codeHeaderHeight - metrics.ascent - metrics.descent) / 2f
        val glyph = look.codeHeaderTextSize
        val glyphRight = width - look.codeCorner
        val glyphLeft = glyphRight - glyph
        val glyphTop = top + (look.codeHeaderHeight - glyph) / 2f
        val editingLanguage = openField == (codeStart to CodeHeaderField.Kind.LANGUAGE)
        if (copiedBlock == codeStart) drawCheckmark(canvas, glyphLeft, glyphTop, glyph)
        else if (!editingLanguage) drawCopyGlyph(canvas, glyphLeft, glyphTop, glyph)
        val room = glyphLeft - look.codeChipPad - look.codeCorner
        val language = block.language?.takeIf { it.isNotEmpty() }
        val languageText = language ?: labels.languagePlaceholder
        val shownLanguage = TextUtils.ellipsize(languageText, languagePaint, room / 2f, TextUtils.TruncateAt.END)
        val languageRight = glyphLeft - look.codeChipPad
        val languageLeft = languageRight - languagePaint.measureText(shownLanguage, 0, shownLanguage.length)
        if ((language != null || header.active) && !editingLanguage) {
            if (language == null) languagePaint.alpha = GHOST_ALPHA
            canvas.drawText(shownLanguage, 0, shownLanguage.length, languageLeft, baseline, languagePaint)
        }
        val nameRight = languageLeft - look.codeChipPad
        var nameEnd = look.codeCorner
        block.name?.takeIf { it.isNotEmpty() }?.let { name ->
            val shown = TextUtils.ellipsize(name, namePaint, nameRight - look.codeCorner, TextUtils.TruncateAt.END)
            if (openField != (codeStart to CodeHeaderField.Kind.NAME)) canvas.drawText(shown, 0, shown.length, look.codeCorner, baseline, namePaint)
            nameEnd += namePaint.measureText(shown, 0, shown.length)
        }
        val nameBoxEnd = maxOf(nameEnd, look.codeCorner + namePaint.measureText(labels.namePlaceholder)).coerceAtMost(nameRight)
        targets.add(CodeBlockTarget(RectF(0f, top, nameBoxEnd + look.codeChipPad, bottom), CodeBlockAction.NAME_FIELD, codeStart, block))
        targets.add(CodeBlockTarget(RectF(languageLeft - look.codeChipPad, top, languageRight, bottom), CodeBlockAction.LANGUAGE_LABEL, codeStart, block))
        targets.add(CodeBlockTarget(RectF(languageRight, top, width, bottom), CodeBlockAction.COPY_CODE, codeStart, block))
        if (!header.lineAbove) return
        val label = edgeLabel(labels.addLineAbove, nameRight - nameBoxEnd - look.codeChipPad * 2)
        if (label.isEmpty()) return
        val labelWidth = edgePaint.measureText(label) + look.codeChipPad * 2
        val center = ((nameBoxEnd + nameRight) / 2f).coerceIn(nameBoxEnd + labelWidth / 2f, nameRight - labelWidth / 2f)
        drawEdgeLabel(canvas, label, center, top, bottom)
        targets.add(CodeBlockTarget(RectF(center - labelWidth / 2f, top, center + labelWidth / 2f, bottom), CodeBlockAction.OPEN_LINE_ABOVE, codeStart))
    }

    /** Where [action]'s part of the block at [codeStart] was last drawn, in layout coordinates. */
    fun areaOf(codeStart: Int, action: CodeBlockAction): RectF? = targets.lastOrNull { it.codeStart == codeStart && it.action == action }?.area

    /** "Add a line below", centred in the skirt band [top] to [bottom]. */
    fun drawLineBelow(canvas: Canvas, codeStart: Int, width: Float, top: Float, bottom: Float) {
        val label = edgeLabel(labels.addLineBelow, width - look.codeCorner * 2)
        if (label.isNotEmpty()) drawEdgeLabel(canvas, label, width / 2f, top, bottom)
        targets.add(CodeBlockTarget(RectF(0f, top, width, bottom), CodeBlockAction.OPEN_LINE_BELOW, codeStart))
    }

    /**
     * The strip above a block that opens the note answers nothing (!300 cb 335-345): the only thing
     * above the block is its hidden opening fence, and "add a line above" is the way up there.
     */
    fun addSpaceAbove(codeStart: Int, width: Float, bottom: Float) {
        targets.add(CodeBlockTarget(RectF(0f, -Float.MAX_VALUE, width, bottom), CodeBlockAction.NOTHING, codeStart))
    }

    /** The empty space under a block that ends the note, from [top] down: a press there opens a line below it. */
    fun addSpaceBelow(codeStart: Int, width: Float, top: Float) {
        targets.add(CodeBlockTarget(RectF(0f, top, width, Float.MAX_VALUE), CodeBlockAction.OPEN_LINE_BELOW, codeStart))
    }

    private fun edgeLabel(text: String, room: Float): String {
        edgePaint.typeface = look.regular
        edgePaint.textSize = look.codeEdgeLabelSize
        edgePaint.color = look.mutedColor
        return TextUtils.ellipsize(text, edgePaint, room, TextUtils.TruncateAt.END).toString()
    }

    private fun drawEdgeLabel(canvas: Canvas, label: String, center: Float, top: Float, bottom: Float) {
        val metrics = edgePaint.fontMetrics
        val baseline = (top + bottom - metrics.ascent - metrics.descent) / 2f
        canvas.drawText(label, center - edgePaint.measureText(label) / 2f, baseline, edgePaint)
    }

    /** The copy glyph's confirmation, [size] square at ([left], [top]). */
    private fun drawCheckmark(canvas: Canvas, left: Float, top: Float, size: Float) {
        glyphPaint.color = look.mutedColor
        glyphPaint.strokeWidth = size / 9f
        glyphPaint.strokeCap = Paint.Cap.ROUND
        canvas.drawLine(left + size * 0.12f, top + size * 0.55f, left + size * 0.4f, top + size * 0.82f, glyphPaint)
        canvas.drawLine(left + size * 0.4f, top + size * 0.82f, left + size * 0.9f, top + size * 0.2f, glyphPaint)
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

    private companion object {
        /** The ghost "language" is inked lighter than a language the block has. */
        const val GHOST_ALPHA = 0x80
    }
}
