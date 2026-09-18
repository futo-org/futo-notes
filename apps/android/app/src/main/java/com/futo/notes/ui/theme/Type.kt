package com.futo.notes.ui.theme

import androidx.compose.material3.Typography
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp

/**
 * FUTO Notes — named brand styles, built on the families in `Fonts.kt`.
 *
 * Working weights: 600 (display/headings), 500 (titles, buttons, UI labels),
 * 400 (body & captions). Tracking is tight & negative, easing off as size
 * grows. A few are mapped onto Material3 [Typography] slots below, but prefer
 * reading these directly (e.g. `FutoType.title`) so intent is explicit — which
 * is also why the families live in their own file: [FutoTypography] reads
 * [FutoType], so if [FutoType] read a top-level val from THIS file, the first
 * code to touch `FutoType.caption` would initialise the two in a cycle and get
 * a null style back.
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

    // ── The License plate (Steel Ledger) ────────────────────────────────────
    // The mock's Barlow Condensed becomes Barlow 700 uppercased at the call
    // site with positive tracking — the only positive tracking in this ramp,
    // because the plate's name is engraved rather than set. (The key is the one
    // place the plate does ship a font of its own; see [FutoMono].)
    val plateName = TextStyle(fontFamily = Barlow, fontWeight = FontWeight.Bold, fontSize = 22.sp, lineHeight = 26.sp, letterSpacing = 0.02.em)

    // The Unlicensed state's ask ("Pay for FUTO Notes"). Smaller than the
    // engraved name above and not tracked, because it is a SENTENCE: it borrowed
    // plateName at first and read as a second letterhead rather than as the
    // thing being asked. Desktop sets the same pair at 19px against the name's
    // 24px; this is that ratio in Barlow.
    val plateAsk  = TextStyle(fontFamily = Barlow, fontWeight = FontWeight.SemiBold, fontSize = 18.sp, lineHeight = 24.sp, letterSpacing = (-0.011).em)

    // A license key is data, not prose: [FutoMono], so the masked dots and the
    // revealed key sit on the same grid and the value does not reflow when it
    // is revealed. Weight 400 because that is the only weight the bundled file
    // carries; asking for 500 would only buy a synthesised one.
    val plateKey  = TextStyle(fontFamily = FutoMono, fontWeight = FontWeight.Normal, fontSize = 11.sp, lineHeight = 17.sp, letterSpacing = 0.em)
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
