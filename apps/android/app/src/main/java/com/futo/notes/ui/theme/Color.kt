package com.futo.notes.ui.theme

import androidx.compose.ui.graphics.Color

/**
 * FUTO Notes — color tokens ("Ambient Precision").
 *
 * Source of truth is the design handoff's /references/colors_and_type.css. The
 * neutral ramp and ember tints there are authored in oklch (warm hue ~60–70);
 * the hex below are faithful sRGB conversions for Compose.
 *
 * Golden rule: EMBER IS RATIONED. One accent per screen — the FAB, the active
 * state, the "answer/related" spark, the selected folder. Never decoration.
 */
object FutoPalette {
    // Core brand (verbatim from the board)
    val Paper    = Color(0xFFFFFFFF)
    val Ink      = Color(0xFF1A1A1A)
    val TextInk  = Color(0xFF1E1E1E)
    val Ember    = Color(0xFFFF9000)
    val Hairline = Color(0xFFE6E6E6)

    // Warm neutral ramp
    val N0   = Color(0xFFFEFEFD)
    val N50  = Color(0xFFFBFAF8)
    val N100 = Color(0xFFF4F2EF)
    val N200 = Color(0xFFE7E4DF)
    val N300 = Color(0xFFD2CEC7)
    val N400 = Color(0xFFABA69D)
    val N500 = Color(0xFF8A847A)
    val N600 = Color(0xFF6E685F)
    val N700 = Color(0xFF544F47)
    val N800 = Color(0xFF3A362F)
    val N900 = Color(0xFF262320)

    // Ember tints & shades
    val Ember50  = Color(0xFFFDF1E3)
    val Ember100 = Color(0xFFFBE0C2)
    val Ember200 = Color(0xFFF8C088)
    val Ember400 = Color(0xFFFBA53A) // hover-light
    val Ember500 = Ember             // base
    val Ember600 = Color(0xFFE97A00) // press / darker
    val Ember700 = Color(0xFFC16400) // text-on-light accent

    // Status (low-chroma, deferential)
    val Success = Color(0xFF3E9B63)
    val Warning = Ember600
    val Danger  = Color(0xFFD64A3B)
    val Info    = Color(0xFF5B86C9)

    // Dark surfaces (brand defines an Ink surface; warm-light neutrals on top).
    val InkBg      = Color(0xFF141210) // app background, slightly warmer than Ink
    val InkSurface = Color(0xFF1F1C19) // raised paper in dark
    val InkSunken  = Color(0xFF1A1714)
    val InkHairline = Color(0xFF332F2A)
    val InkSelected = Color(0xFF2E2317) // ember-tinted selection in dark

    // Text on an ink/inverse surface (warm off-white).
    val OnInk = Color(0xFFF3F1EC)
}

/**
 * Extended semantic tokens that don't map cleanly onto a Material3 ColorScheme.
 * Exposed via [LocalFutoColors] so composables can read e.g.
 * `FutoTheme.colors.textSecondary`. Light values are the defaults; the dark
 * variant is built in [darkFutoColors].
 */
data class FutoColors(
    val surface: Color = FutoPalette.Paper,
    val surfaceSunken: Color = FutoPalette.N50,
    val surfaceHover: Color = FutoPalette.N100,
    val surfaceSelected: Color = FutoPalette.Ember50,
    val surfaceInverse: Color = FutoPalette.Ink,

    val textPrimary: Color = FutoPalette.TextInk,
    val textSecondary: Color = FutoPalette.N700,
    val textTertiary: Color = FutoPalette.N600,
    val textMuted: Color = FutoPalette.N500,
    val textOnInk: Color = Color(0xFFF3F1EC),
    val textAccent: Color = FutoPalette.Ember700,

    val border: Color = FutoPalette.Hairline,
    val borderStrong: Color = FutoPalette.N300,
    val borderFocus: Color = FutoPalette.Ember500,

    val accent: Color = FutoPalette.Ember500,
    val accentHover: Color = FutoPalette.Ember400,
    val accentPress: Color = FutoPalette.Ember600,

    val success: Color = FutoPalette.Success,
    val warning: Color = FutoPalette.Warning,
    val danger: Color = FutoPalette.Danger,
    val info: Color = FutoPalette.Info,

    val isDark: Boolean = false,
)

/**
 * Dark companion to the (light) [FutoColors] defaults. The brand only fully
 * specifies light, so this is a faithful inversion: ink surfaces, warm-light
 * neutrals for text, the SAME ember (it reads well on dark and stays the one
 * rationed accent). Tuned alongside the dark ColorScheme in Theme.kt.
 */
val darkFutoColors = FutoColors(
    surface = FutoPalette.InkSurface,
    surfaceSunken = FutoPalette.InkSunken,
    surfaceHover = FutoPalette.InkHairline,
    surfaceSelected = FutoPalette.InkSelected,
    surfaceInverse = FutoPalette.Paper,

    textPrimary = Color(0xFFF3F1EC),
    textSecondary = FutoPalette.N300,
    textTertiary = FutoPalette.N400,
    textMuted = FutoPalette.N500,
    textOnInk = Color(0xFFF3F1EC),
    textAccent = FutoPalette.Ember400,

    border = FutoPalette.InkHairline,
    borderStrong = FutoPalette.N700,
    borderFocus = FutoPalette.Ember500,

    accent = FutoPalette.Ember500,
    accentHover = FutoPalette.Ember400,
    accentPress = FutoPalette.Ember600,

    success = FutoPalette.Success,
    warning = FutoPalette.Warning,
    danger = FutoPalette.Danger,
    info = FutoPalette.Info,

    isDark = true,
)
