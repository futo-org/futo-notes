package com.futo.notes.ui.theme

import androidx.compose.ui.graphics.Color

object FutoPalette {
    // Core brand (verbatim from the board)
    val Paper    = Color(0xFFFFFFFF)
    val Ink      = Color(0xFF1A1A1A)
    val TextInk  = Color(0xFF1E1E1E)
    val Ember    = Color(0xFFFF9000)
    val Hairline = Color(0xFFE6E6E6)

    // Warm neutral ramp
    val N50  = Color(0xFFFBFAF8)
    val N100 = Color(0xFFF4F2EF)
    val N200 = Color(0xFFE7E4DF)
    val N300 = Color(0xFFD2CEC7)
    val N400 = Color(0xFFABA69D)
    val N500 = Color(0xFF8A847A)
    val N600 = Color(0xFF6E685F)
    val N700 = Color(0xFF544F47)
    val N800 = Color(0xFF3A362F)

    // Ember tints & shades
    val Ember50  = Color(0xFFFDF1E3)
    val Ember200 = Color(0xFFF8C088)
    val Ember400 = Color(0xFFFBA53A) // hover-light
    val Ember500 = Ember             // base
    val Ember700 = Color(0xFFC16400) // text-on-light accent

    // Status (low-chroma, deferential)
    val Success = Color(0xFF3E9B63)
    val Danger  = Color(0xFFD64A3B)

    // Dark surfaces (brand defines an Ink surface; warm-light neutrals on top).
    val InkBg      = Color(0xFF141210) // app background, slightly warmer than Ink
    val InkSurface = Color(0xFF1F1C19) // raised paper in dark
    val InkSunken  = Color(0xFF1A1714)
    val InkHairline = Color(0xFF332F2A)
    val InkSelected = Color(0xFF2E2317) // ember-tinted selection in dark

    // Text on an ink/inverse surface (warm off-white).
    val OnInk = Color(0xFFF3F1EC)

    // ── Steel Ledger (the License plate) ────────────────────────────────────
    // Gunmetal and gold, and deliberately NOT the warm neutral ramp above: the
    // license plate is the one surface in the app made of a different material,
    // and it is that on all three platforms (docs/plan/license-ship.md D1/D5).
    // These are the same values the desktop plate defines as --plate-* in
    // src/features/license/LicenseSettingsSection.svelte — change one, change
    // all three shells.
    val PlateTopLight    = Color(0xFFDFE4E8) // --plate-a
    val PlateBottomLight = Color(0xFFCDD5DC) // --plate-b
    val PlateInkLight    = Color(0xFF1C2733)
    val PlateInkDimLight = Color(0xFF4F5D6A)
    val PlateRuleLight   = Color(0xFFA9B4BE)
    val PlateGoldLight   = Color(0xFFB8860B)

    val PlateTopDark     = Color(0xFF2A3139)
    val PlateBottomDark  = Color(0xFF1C2228)
    val PlateInkDark     = Color(0xFFE6EBEF)
    val PlateInkDimDark  = Color(0xFF9AA6B1)
    val PlateRuleDark    = Color(0xFF3D4650)
    val PlateGoldDark    = Color(0xFFFFBB00)
}

/**
 * The well's inset shadow — the only thing that says the 184dp circle is sunk
 * into the plate, since it carries no fill and no ring (D1).
 *
 * Identical in both themes on purpose: a depression is geometry, not colour,
 * and the CSS the desktop plate uses
 * (`inset 0 2px 6px rgba(0,0,0,.28), inset 0 -1px 0 rgba(255,255,255,.35)`)
 * is likewise one declaration for both. Kept out of [FutoColors] for exactly
 * that reason — there is nothing for the dark variant to override.
 */
object FutoPlateWell {
    /** rgba(0, 0, 0, .28) — the cast shadow under the top edge and around the rim. */
    val Shadow = Color(0x47000000)

    /** rgba(255, 255, 255, .35) — the light line along the bottom inside edge. */
    val Highlight = Color(0x59FFFFFF)
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
    val surfaceSelected: Color = FutoPalette.Ember50,
    val surfaceInverse: Color = FutoPalette.Ink,

    val textPrimary: Color = FutoPalette.TextInk,
    val textSecondary: Color = FutoPalette.N700,
    val textTertiary: Color = FutoPalette.N600,
    val textMuted: Color = FutoPalette.N500,
    val textOnInk: Color = Color(0xFFF3F1EC),
    val textAccent: Color = FutoPalette.Ember700,

    val border: Color = FutoPalette.Hairline,

    val accent: Color = FutoPalette.Ember500,

    val success: Color = FutoPalette.Success,
    val danger: Color = FutoPalette.Danger,

    // The License plate (Steel Ledger). Read only by the license card; every
    // other Settings group is still the app's own paper-and-hairline surface.
    val plateTop: Color = FutoPalette.PlateTopLight,
    val plateBottom: Color = FutoPalette.PlateBottomLight,
    val plateInk: Color = FutoPalette.PlateInkLight,
    val plateInkDim: Color = FutoPalette.PlateInkDimLight,
    val plateRule: Color = FutoPalette.PlateRuleLight,
    /** Gold. Rules, the badge border and the plate's own links — never a fill. */
    val plateAccent: Color = FutoPalette.PlateGoldLight,
)

val darkFutoColors = FutoColors(
    surface = FutoPalette.InkSurface,
    surfaceSunken = FutoPalette.InkSunken,
    surfaceSelected = FutoPalette.InkSelected,
    surfaceInverse = FutoPalette.Paper,

    textPrimary = Color(0xFFF3F1EC),
    textSecondary = FutoPalette.N300,
    textTertiary = FutoPalette.N400,
    textMuted = FutoPalette.N500,
    textOnInk = Color(0xFFF3F1EC),
    textAccent = FutoPalette.Ember400,

    border = FutoPalette.InkHairline,

    accent = FutoPalette.Ember500,

    success = FutoPalette.Success,
    danger = FutoPalette.Danger,

    plateTop = FutoPalette.PlateTopDark,
    plateBottom = FutoPalette.PlateBottomDark,
    plateInk = FutoPalette.PlateInkDark,
    plateInkDim = FutoPalette.PlateInkDimDark,
    plateRule = FutoPalette.PlateRuleDark,
    plateAccent = FutoPalette.PlateGoldDark,
)
