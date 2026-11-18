package com.futo.notes.textfirst

import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Typeface
import android.text.TextPaint
import android.text.TextUtils
import kotlin.math.floor

/** What a press on a drawn part of a code block does. */
internal enum class CodeBlockAction { SELECT_BLOCK, NAME_FIELD, LANGUAGE_LABEL, COPY_CODE, OPEN_LINE_ABOVE, OPEN_LINE_BELOW, NOTHING }

/** One block's header as drawn: [revealFields] while the caret is in the block, so its empty fields show their placeholders. */
/** [openField] is the header field open on this block, whose text is the field's to show. */
internal class CodeHeaderState(val block: CodeBlockFacts, val codeStart: Int, val left: Float, val right: Float, val top: Float, val lineAbove: Boolean, val revealFields: Boolean, val openField: CodeHeaderField.Kind?, val copied: Boolean)

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
    private val baselinePaint = TextPaint(Paint.ANTI_ALIAS_FLAG)
    private val targets = ArrayList<CodeBlockTarget>()

    var labels = CodeBlockLabels("", "", "", "")
    private val numbers = TextPaint(Paint.ANTI_ALIAS_FLAG)

    /** The line box "add a line below" was last drawn in, in layout coordinates. */
    var belowLabelBox: RectF? = null
        private set

    fun clearTargets() {
        targets.clear()
        belowLabelBox = null
    }

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
        val left = header.left
        val right = header.right
        val top = header.top
        namePaint.typeface = look.mono
        namePaint.textSize = look.codeHeaderTextSize
        namePaint.color = look.codeChromeInk
        val language = block.language?.takeIf { it.isNotEmpty() }
        // !300 draws a language in Barlow 500 and its ghost "language" in Barlow.
        languagePaint.typeface = if (language != null) look.medium else look.regular
        languagePaint.textSize = look.codeHeaderTextSize
        languagePaint.color = look.codeChromeInk
        val bottom = top + look.codeHeaderHeight
        targets.add(CodeBlockTarget(RectF(left, top, right, bottom), CodeBlockAction.SELECT_BLOCK, codeStart, block))
        val baseline = headerBaseline(top, languagePaint.typeface)
        val nameBaseline = headerBaseline(top, look.mono)
        // !300's glyph box: 12 px against its 18 px body.
        val glyph = look.codeHeaderTextSize * 16f / 18f
        val glyphRight = right - look.codeCorner
        val glyphLeft = glyphRight - glyph
        // !300 sets the glyph 3 px above the header's middle.
        val glyphTop = top + (look.codeHeaderHeight - glyph) / 2f - look.codeGlyphLift
        val editingLanguage = header.openField == CodeHeaderField.Kind.LANGUAGE
        if (header.copied) drawCheckmark(canvas, glyphLeft, glyphTop, glyph)
        else if (!editingLanguage) drawCopyGlyph(canvas, glyphLeft, glyphTop, glyph)
        val room = glyphLeft - look.codeChipPad - look.codeCorner
        // Shown as written in the fence, as the desktop editor shows it (Mason, 2026-11-17).
        val languageText = language ?: labels.languagePlaceholder
        // !300 caps the language chip at 30% of the header.
        val shownLanguage = TextUtils.ellipsize(languageText, languagePaint, minOf(room, (right - left) * LANGUAGE_SHARE), TextUtils.TruncateAt.END)
        val languageRight = glyphLeft - look.codeGlyphGap
        val languageLeft = languageRight - languagePaint.measureText(shownLanguage, 0, shownLanguage.length)
        if ((language != null || header.revealFields) && !editingLanguage) {
            if (language == null) languagePaint.alpha = GHOST_ALPHA
            canvas.drawText(shownLanguage, 0, shownLanguage.length, languageLeft, baseline, languagePaint)
        }
        val nameRight = languageLeft - look.codeChipPad
        val nameLeft = left + look.codeFieldInset + look.codeChipPad
        var nameEnd = nameLeft
        // The ghost "name" tells a reader with no hover that the header is editable (cb 671-677).
        if (block.name.isNullOrEmpty() && header.revealFields && header.openField != CodeHeaderField.Kind.NAME) {
            namePaint.alpha = GHOST_ALPHA
            canvas.drawText(labels.namePlaceholder, nameLeft, nameBaseline, namePaint)
        }
        block.name?.takeIf { it.isNotEmpty() }?.let { name ->
            val chars = nameChars(left, right)
            val capped = if (name.length > chars) name.take(chars - 1) + "\u2026" else name
            val shown = TextUtils.ellipsize(capped, namePaint, nameRight - nameLeft, TextUtils.TruncateAt.END)
            if (header.openField != CodeHeaderField.Kind.NAME) canvas.drawText(shown, 0, shown.length, nameLeft, nameBaseline, namePaint)
            nameEnd += namePaint.measureText(shown, 0, shown.length)
        }
        val nameBoxEnd = (maxOf(nameEnd, nameLeft + namePaint.measureText(labels.namePlaceholder)) + look.codeNameEndPad).coerceAtMost(nameRight)
        targets.add(CodeBlockTarget(RectF(left, top, nameBoxEnd, bottom), CodeBlockAction.NAME_FIELD, codeStart, block))
        targets.add(CodeBlockTarget(RectF(languageLeft - look.codeChipPad, top, languageRight, bottom), CodeBlockAction.LANGUAGE_LABEL, codeStart, block))
        targets.add(CodeBlockTarget(RectF(languageRight, top, right, bottom), CodeBlockAction.COPY_CODE, codeStart, block))
        if (!header.lineAbove) return
        val label = edgeLabel(labels.addLineAbove, nameRight - nameBoxEnd - look.codeChipPad * 2)
        if (label.isEmpty()) return
        val labelWidth = edgePaint.measureText(label) + look.codeChipPad * 2
        // Centred in !300's header space: from the name field's padded end to the language chip.
        val center = ((nameBoxEnd + nameRight) / 2f).coerceIn(nameBoxEnd + labelWidth / 2f, nameRight - labelWidth / 2f)
        drawEdgeLabel(canvas, label, center, top, bottom)
        targets.add(CodeBlockTarget(RectF(center - labelWidth / 2f, top, center + labelWidth / 2f, bottom), CodeBlockAction.OPEN_LINE_ABOVE, codeStart))
    }

    /**
     * The most characters a name shows in a header from [left] to [right], its ellipsis among them: !300's field is at
     * most 30 characters or 45% of the header. The 45% is counted in !300's glyphs (the system monospace, 0.6 em), so a
     * long name is cut at the same character as !300's though ours are a little wider.
     */
    fun nameChars(left: Float, right: Float): Int {
        val referenceGlyph = look.codeHeaderTextSize * 0.6f
        val fits = ((right - left) * NAME_SHARE - look.codeChipPad - look.codeNameEndPad) / referenceGlyph
        // At least one: a note too narrow for a letter still shows the ellipsis, not a negative cut.
        return floor(fits).toInt().coerceIn(1, 30)
    }

    /**
     * The baseline that centres a header text in [face] on a header whose top is [top]: the drawn
     * label and its open field both sit on it.
     */
    fun headerBaseline(top: Float, face: Typeface): Float {
        val metrics = baselinePaint.apply { typeface = face; textSize = look.codeHeaderTextSize }.fontMetrics
        return top + (look.codeHeaderHeight - metrics.ascent - metrics.descent) / 2f
    }

    /** Where [action]'s part of the block at [codeStart] was last drawn, in layout coordinates. */
    fun areaOf(codeStart: Int, action: CodeBlockAction): RectF? = targets.lastOrNull { it.codeStart == codeStart && it.action == action }?.area

    /**
     * "Add a line below", a skirt-tall line box from [labelTop], centred across the card; a press from
     * its top down to [pressBottom] opens the line (!300's page: the box sits 0.2 skirt
     * above the skirt, and the strip under it reaches the next card).
     */
    fun drawLineBelow(canvas: Canvas, codeStart: Int, width: Float, labelTop: Float, pressBottom: Float) {
        val label = edgeLabel(labels.addLineBelow, width - look.codeCorner * 2)
        val box = RectF(0f, labelTop, width, labelTop + look.codeSkirt)
        belowLabelBox = box
        if (label.isNotEmpty()) drawEdgeLabel(canvas, label, width / 2f, box.top, box.bottom)
        targets.add(CodeBlockTarget(RectF(0f, labelTop, width, maxOf(pressBottom, box.bottom)), CodeBlockAction.OPEN_LINE_BELOW, codeStart))
    }

    /**
     * The strip above a block that opens the note answers nothing (!300 cb 335-345): the only thing
     * above the block is its hidden opening fence, and "add a line above" is the way up there.
     */
    fun addSpaceAbove(codeStart: Int, width: Float, bottom: Float) {
        targets.add(CodeBlockTarget(RectF(0f, -Float.MAX_VALUE, width, bottom), CodeBlockAction.NOTHING, codeStart))
    }

    /** The gap between this block and the one touching it below, [top] to [bottom]: a press there opens a line between them. */
    fun addGapBelow(codeStart: Int, width: Float, top: Float, bottom: Float) {
        targets.add(CodeBlockTarget(RectF(0f, top, width, bottom), CodeBlockAction.OPEN_LINE_BELOW, codeStart))
    }

    /** The empty space under a block that ends the note, from [top] down: a press there opens a line below it. */
    fun addSpaceBelow(codeStart: Int, width: Float, top: Float) {
        targets.add(CodeBlockTarget(RectF(0f, top, width, Float.MAX_VALUE), CodeBlockAction.OPEN_LINE_BELOW, codeStart))
    }

    private fun edgeLabel(text: String, room: Float): String {
        edgePaint.typeface = look.regular
        edgePaint.textSize = look.codeEdgeLabelSize
        edgePaint.color = look.codeChromeInk
        return TextUtils.ellipsize(text, edgePaint, room, TextUtils.TruncateAt.END).toString()
    }

    private fun drawEdgeLabel(canvas: Canvas, label: String, center: Float, top: Float, bottom: Float) {
        val metrics = edgePaint.fontMetrics
        val baseline = (top + bottom - metrics.ascent - metrics.descent) / 2f
        canvas.drawText(label, center - edgePaint.measureText(label) / 2f, baseline, edgePaint)
    }

    /** The copy glyph's confirmation, [size] square at ([left], [top]). */
    private fun drawCheckmark(canvas: Canvas, left: Float, top: Float, size: Float) {
        glyphPaint.color = look.codeChromeInk
        glyphPaint.alpha = GLYPH_ALPHA
        glyphPaint.strokeWidth = size / 9f
        glyphPaint.strokeCap = Paint.Cap.ROUND
        canvas.drawLine(left + size * 0.12f, top + size * 0.55f, left + size * 0.4f, top + size * 0.82f, glyphPaint)
        canvas.drawLine(left + size * 0.4f, top + size * 0.82f, left + size * 0.9f, top + size * 0.2f, glyphPaint)
    }

    /** Two overlapping rounded squares, the usual copy mark, [size] square at ([left], [top]). */
    private fun drawCopyGlyph(canvas: Canvas, left: Float, top: Float, size: Float) {
        glyphPaint.color = look.codeChromeInk
        glyphPaint.alpha = GLYPH_ALPHA
        glyphPaint.strokeWidth = size / 11f
        val square = size * 0.6f
        val corner = size * 0.12f
        // The front square hides the back one where they overlap, as !300's icon does.
        glyphBox.set(left + size - square, top + size - square, left + size, top + size)
        val save = canvas.save()
        canvas.clipOutRect(glyphBox.left - glyphPaint.strokeWidth, glyphBox.top - glyphPaint.strokeWidth, glyphBox.right + glyphPaint.strokeWidth, glyphBox.bottom + glyphPaint.strokeWidth)
        canvas.drawRoundRect(left, top, left + square, top + square, corner, corner, glyphPaint)
        canvas.restoreToCount(save)
        canvas.drawRoundRect(glyphBox, corner, corner, glyphPaint)
    }

    fun numberPaint(look: TextFirstStyle): TextPaint = numbers.apply {
        typeface = look.mono
        textSize = look.codeTextSize
    }

    companion object {
        /** !300's placeholders are inked at 0.7 of the header's ink. */
        const val GHOST_ALPHA = 0xB3
        /** !300's copy glyph is inked at 0.7. */
        private const val GLYPH_ALPHA = 0xB3
        /** !300's name takes at most 45% of the header, its language chip 30%: drawn or open in a field. */
        const val NAME_SHARE = 0.45f
        const val LANGUAGE_SHARE = 0.3f
    }
}
