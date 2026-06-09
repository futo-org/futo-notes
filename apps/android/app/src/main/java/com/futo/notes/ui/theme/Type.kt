package com.futo.notes.ui.theme

import androidx.compose.material3.Typography
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import com.futo.notes.R

/**
 * FUTO Notes — type tokens. Brand typeface is **Barlow** (a low-contrast,
 * lightly engineered grotesk — tactile and precise), bundled as TTFs in
 * res/font (offline, "file over app" — no Google Play download dependency).
 *
 * Working weights: 600 (display/headings), 500 (titles, buttons, UI labels),
 * 400 (body & captions). Tracking is tight & negative, easing off as size grows.
 */
val Barlow = FontFamily(
    Font(R.font.barlow_regular, FontWeight.Normal),
    Font(R.font.barlow_medium, FontWeight.Medium),
    Font(R.font.barlow_semibold, FontWeight.SemiBold),
    Font(R.font.barlow_bold, FontWeight.Bold),
)

/**
 * Named brand styles. A few are mapped onto Material3 [Typography] slots below,
 * but prefer reading these directly (e.g. `FutoType.title`) so intent is explicit.
 */
object FutoType {
    val display = TextStyle(fontFamily = Barlow, fontWeight = FontWeight.SemiBold, fontSize = 64.sp, lineHeight = 67.sp, letterSpacing = (-0.018).em)
    val h1      = TextStyle(fontFamily = Barlow, fontWeight = FontWeight.SemiBold, fontSize = 40.sp, lineHeight = 44.sp, letterSpacing = (-0.017).em)
    val h2      = TextStyle(fontFamily = Barlow, fontWeight = FontWeight.SemiBold, fontSize = 30.sp, lineHeight = 35.sp, letterSpacing = (-0.015).em)
    val h3      = TextStyle(fontFamily = Barlow, fontWeight = FontWeight.Medium,   fontSize = 24.sp, lineHeight = 31.sp, letterSpacing = (-0.013).em)
    val title   = TextStyle(fontFamily = Barlow, fontWeight = FontWeight.Medium,   fontSize = 18.sp, lineHeight = 25.sp, letterSpacing = (-0.014).em)
    val body    = TextStyle(fontFamily = Barlow, fontWeight = FontWeight.Normal,   fontSize = 16.sp, lineHeight = 25.sp, letterSpacing = (-0.011).em)
    val small   = TextStyle(fontFamily = Barlow, fontWeight = FontWeight.Normal,   fontSize = 14.sp, lineHeight = 21.sp, letterSpacing = (-0.006).em)
    val caption = TextStyle(fontFamily = Barlow, fontWeight = FontWeight.Normal,   fontSize = 13.sp, lineHeight = 19.sp, letterSpacing = 0.em)
    // micro: render with text.uppercase() at the call site
    val micro   = TextStyle(fontFamily = Barlow, fontWeight = FontWeight.Medium,   fontSize = 11.sp, lineHeight = 15.sp, letterSpacing = 0.01.em)
}

val FutoTypography = Typography(
    displayLarge   = FutoType.display,
    headlineLarge  = FutoType.h1,
    headlineMedium = FutoType.h2,
    headlineSmall  = FutoType.h3,
    titleLarge     = FutoType.title,
    titleMedium    = FutoType.title,
    bodyLarge      = FutoType.body,
    bodyMedium     = FutoType.small,
    bodySmall      = FutoType.caption,
    labelLarge     = FutoType.title.copy(fontWeight = FontWeight.Medium),
    labelMedium    = FutoType.small,
    labelSmall     = FutoType.micro,
)
