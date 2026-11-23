package com.futo.notes.textfirst

import android.graphics.Typeface
import android.text.TextPaint

/** The note's text edge, at either side of the body and of the title above it. */
internal const val NOTE_TEXT_INSET_DP = 18f

/**
 * The look of the text-first editor, matched to the Milkdown surface
 * (milkdownEditor.surface.css): 17px Barlow at 1.55 line height, headings at the
 * desktop editor's sizes and weights, muted quotes behind a 3px rule, monospace code at
 * 0.9em on the code background. Pixel values are resolved once per view.
 */
internal class TextFirstStyle(
    val density: Float,
    val textSizePx: Float,
    val regular: Typeface,
    val semibold: Typeface,
    val bold: Typeface,
    val mono: Typeface,
    var textColor: Int,
    var mutedColor: Int,
    var linkColor: Int,
    var borderColor: Int,
    var codeBackground: Int,
    var surfaceColor: Int,
    val italic: Typeface = regular,
    val boldItalic: Typeface = bold,
    val semiboldItalic: Typeface = Typeface.create(italic, 600, true),
    val medium: Typeface = Typeface.create(regular, 500, false),
    val mediumItalic: Typeface = Typeface.create(italic, 500, true),
    val extraBold: Typeface = Typeface.create(bold, 800, false),
    val extraBoldItalic: Typeface = Typeface.create(boldItalic, 800, true),
    /** The page under the note: a lifted block's card and its dimmed place are painted with it. */
    var pageColor: Int = android.graphics.Color.WHITE,
) {
    fun dp(value: Float) = value * density
    val bodyLineHeight = (textSizePx * 1.55f).toInt()
    /** What the TextView adds below every line to reach [bodyLineHeight] (TextView.setLineHeight). */
    val bodyLineSpacing = bodyLineHeight - TextPaint().apply { typeface = regular; textSize = textSizePx }.getFontMetricsInt(null)

    fun faceForWeight(weight: Int, italic: Boolean): Typeface = when {
        weight <= 400 -> if (italic) this.italic else regular
        weight <= 500 -> if (italic) mediumItalic else medium
        weight <= 600 -> if (italic) semiboldItalic else semibold
        weight <= 700 -> if (italic) boldItalic else bold
        else -> if (italic) extraBoldItalic else extraBold
    }

    /** Bold text on a run of [baseWeight], as on desktop: 700 over a lighter base, 800 over 600 and up. */
    fun boldWeightOver(baseWeight: Int): Int = if (baseWeight >= 600) 800 else 700
    val listIndent = textSizePx * 1.4f
    val quoteIndent = dp(3f) + textSizePx * 0.9f
    val codePadding = dp(12f)
    /** !300's chrome size [px], in CSS px: exact at the default body (17 sp), and scaling with the body's font size. */
    private fun codeMetric(px: Float): Float = textSizePx * px / 17f
    val codeHeaderHeight = codeMetric(27f)
    val codeHeaderTextSize = codeMetric(12f)
    val codeCorner = codeMetric(10f)
    val codeChipPad = codeMetric(7f)
    /** Mason's spacing: each header control's fill stands 2 px from the card's top and side, 24 px tall (!300). */
    val codeFieldInset = codeMetric(2f)
    val codeFieldHeight = codeMetric(24f)
    /** !300's space between the language label and the copy glyph. */
    val codeGlyphGap = codeMetric(5.3f)
    val codeGlyphLift = codeMetric(0.8f)
    val codeNameEndPad = codeMetric(4f)
    val codeSkirt = codeMetric(10f)
    val codeRadius = codeMetric(6f)
    val codeBlockGap = codeMetric(4f)
    val codeEdgeLabelSize = codeMetric(10f)
    // !300's code: 15.84 px text on a 27.72 px line (0.88 and 1.75 of its 18 px body), its px at our default body.
    val codeTextSize = codeMetric(15.84f)
    val codeLineHeight = codeMetric(27.72f)
    /** !300's gutter, from the card's text column: the numbers end, the rule, the code (cb 264-283). */
    val codeNumbersEnd = codeMetric(21.9f)
    val codeRuleGap = codeMetric(9f)
    val codeTextGap = codeMetric(7.5f)
    /** How far a code card stands past the text column on each side. */
    val codeCardOutset get() = dp(6f)
    private val darkTheme get() = androidx.core.graphics.ColorUtils.calculateLuminance(textColor) > 0.5
    // !300's --code-well-*, --code-mark-* and its gutter rule (ink at 9%), light and dark.
    val codeWellColor get() = if (darkTheme) 0x0AFFFFFF else 0x0E000000
    val codeWellBorderColor get() = if (darkTheme) 0x0FFFFFFF else 0x0F000000
    val codeRuleColor get() = (textColor and 0x00ffffff) or 0x17000000
    /** !300's muted ink for a block's header, edge labels and copy glyph, read from its page: #737373, #A3A3A3 in dark. */
    val codeChromeInk get() = if (darkTheme) 0xFFA3A3A3.toInt() else 0xFF737373.toInt()
    /** !300's gutter ink: #737373, #A3A3A3 in dark, at 55%. */
    val codeNumberColor get() = if (darkTheme) 0x8CA3A3A3.toInt() else 0x8C737373.toInt()
    /** A number on a line the selection is on (!300 cb 267-276). */
    val codeNumberActiveColor get() = codeChromeInk
    val selectionColor get() = (linkColor and 0x00ffffff) or 0x40000000
    /** The body's border over the header's fill would vanish (the same colour in dark): a step of the text colour over it. */
    val tableHeaderBorderColor get() = androidx.core.graphics.ColorUtils.compositeColors((textColor and 0x00ffffff) or 0x26000000, codeBackground)

    /** Find-match highlight: the link colour, stronger for the current match. */
    fun findMarkColor(current: Boolean) = (linkColor and 0x00ffffff) or (if (current) 0x99000000.toInt() else 0x40000000)
}
