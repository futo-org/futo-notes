package com.futo.notes.ui.theme

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Shapes
import androidx.compose.ui.unit.dp

/**
 * Radii — soft and generous. 12.dp is the SIGNATURE (cards, inputs, buttons,
 * the app-icon squircle). Nothing in the product is sharp-cornered.
 */
object FutoRadius {
    val xs = 6.dp
    val sm = 10.dp
    val md = 12.dp   // signature
    val lg = 16.dp
    val xl = 22.dp
    val xxl = 28.dp
    val pill = 999.dp
}

val FutoShapes = Shapes(
    extraSmall = RoundedCornerShape(FutoRadius.xs),
    small = RoundedCornerShape(FutoRadius.sm),
    medium = RoundedCornerShape(FutoRadius.md),
    large = RoundedCornerShape(FutoRadius.lg),
    extraLarge = RoundedCornerShape(FutoRadius.xl),
)

/**
 * Spacing — 4.dp base grid, calm rhythm. sp6 (24.dp) is the default gutter
 * between unrelated blocks; sp3/sp4 inside components.
 */
object FutoSpacing {
    val sp1 = 4.dp
    val sp2 = 8.dp
    val sp3 = 12.dp
    val sp4 = 16.dp
    val sp5 = 20.dp
    val sp6 = 24.dp
    val sp8 = 32.dp
    val sp10 = 40.dp
    val sp12 = 48.dp
    val sp16 = 64.dp
    val sp20 = 80.dp
    val sp24 = 96.dp
}

/**
 * Elevation — barely-there, warm-cast. Most resting surfaces use only a 1.dp
 * hairline border; reserve real shadow for menus, sheets, the FAB. When you use
 * Modifier.shadow(), tint it warm via spotColor/ambientColor ([FutoShadowTint])
 * so it never reads as a cold grey drop shadow.
 */
object FutoElevation {
    val xs = 1.dp
    val sm = 2.dp
    val md = 6.dp
    val lg = 12.dp
    val xl = 24.dp
}
