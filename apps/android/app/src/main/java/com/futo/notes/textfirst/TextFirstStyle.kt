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
    // iOS's 16-point header and 11-point label against its 17-point body, scaled with the body text.
    val codeLabelHeader = textSizePx * 16f / 17f
    val codeLabelSize = textSizePx * 11f / 17f
    val selectionColor get() = (linkColor and 0x00ffffff) or 0x40000000
    /** The body's border over the header's fill would vanish (the same colour in dark): a step of the text colour over it. */
    val tableHeaderBorderColor get() = androidx.core.graphics.ColorUtils.compositeColors((textColor and 0x00ffffff) or 0x26000000, codeBackground)

    /** Find-match highlight: the link colour, stronger for the current match. */
    fun findMarkColor(current: Boolean) = (linkColor and 0x00ffffff) or (if (current) 0x99000000.toInt() else 0x40000000)
}
