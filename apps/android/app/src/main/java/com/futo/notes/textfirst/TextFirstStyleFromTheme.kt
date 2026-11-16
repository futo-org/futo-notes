package com.futo.notes.textfirst

import android.content.Context
import androidx.compose.ui.graphics.toArgb
import androidx.core.content.res.ResourcesCompat
import com.futo.notes.R
import com.futo.notes.ui.theme.FutoColors
import com.futo.notes.ui.theme.FutoPalette

/** The editor's look from the app theme: Barlow at 17sp scaled by the system font size. */
internal fun textFirstStyleFromTheme(context: Context, colors: FutoColors, darkTheme: Boolean): TextFirstStyle {
    val density = context.resources.displayMetrics.density
    val scaled = context.resources.displayMetrics.scaledDensity
    val regular = ResourcesCompat.getFont(context, R.font.barlow_regular)!!
    return TextFirstStyle(
        density = density,
        textSizePx = 17f * scaled,
        regular = regular,
        semibold = ResourcesCompat.getFont(context, R.font.barlow_semibold)!!,
        bold = ResourcesCompat.getFont(context, R.font.barlow_bold)!!,
        italic = ResourcesCompat.getFont(context, R.font.barlow_italic)!!,
        boldItalic = ResourcesCompat.getFont(context, R.font.barlow_bold_italic)!!,
        semiboldItalic = ResourcesCompat.getFont(context, R.font.barlow_semibold_italic)!!,
        mono = ResourcesCompat.getFont(context, R.font.jetbrains_mono_regular)!!,
        textColor = colors.textPrimary.toArgb(),
        mutedColor = colors.textMuted.toArgb(),
        linkColor = colors.accent.toArgb(),
        borderColor = colors.border.toArgb(),
        codeBackground = (if (darkTheme) FutoPalette.InkHairline else FutoPalette.N200).toArgb(),
        surfaceColor = colors.surfaceSunken.toArgb(),
    )
}
