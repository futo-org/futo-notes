package com.futo.notes.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.staticCompositionLocalOf

/**
 * FUTO Notes theme ("Ambient Precision"). Wraps MaterialTheme so standard M3
 * components (TopAppBar, Card, FilterChip, Switch, FloatingActionButton,
 * ModalNavigationDrawer, SegmentedButton, …) inherit the brand out of the box,
 * and ALSO exposes the extended FUTO tokens via `FutoTheme.colors`.
 *
 * Usage:
 *   FutoNotesTheme { AppScaffold() }
 *   val c = FutoTheme.colors            // FutoColors (light or dark)
 *   Text("Title", style = FutoType.title, color = c.textPrimary)
 *
 * Dark mode: the brand only fully specifies light, so the dark scheme is a
 * faithful inversion (ink surfaces, warm-light neutrals, same rationed ember).
 */
private val FutoLightColorScheme = lightColorScheme(
    primary = FutoPalette.Ember500,
    onPrimary = FutoPalette.Paper,
    primaryContainer = FutoPalette.Ember50,
    onPrimaryContainer = FutoPalette.Ember700,
    secondary = FutoPalette.N700,
    onSecondary = FutoPalette.Paper,
    secondaryContainer = FutoPalette.N100,
    onSecondaryContainer = FutoPalette.N800,
    background = FutoPalette.N50,
    onBackground = FutoPalette.TextInk,
    surface = FutoPalette.Paper,
    onSurface = FutoPalette.TextInk,
    surfaceVariant = FutoPalette.N100,
    onSurfaceVariant = FutoPalette.N700,
    surfaceContainer = FutoPalette.N50,
    surfaceContainerHigh = FutoPalette.N100,
    outline = FutoPalette.N300,
    outlineVariant = FutoPalette.Hairline,
    inverseSurface = FutoPalette.Ink,
    inverseOnSurface = FutoPalette.OnInk,
    error = FutoPalette.Danger,
)

private val FutoDarkColorScheme = darkColorScheme(
    primary = FutoPalette.Ember500,
    onPrimary = FutoPalette.Ink,
    primaryContainer = FutoPalette.InkSelected,
    onPrimaryContainer = FutoPalette.Ember200,
    secondary = FutoPalette.N300,
    onSecondary = FutoPalette.Ink,
    secondaryContainer = FutoPalette.InkHairline,
    onSecondaryContainer = FutoPalette.N200,
    background = FutoPalette.InkBg,
    onBackground = FutoPalette.OnInk,
    surface = FutoPalette.InkSurface,
    onSurface = FutoPalette.OnInk,
    surfaceVariant = FutoPalette.InkHairline,
    onSurfaceVariant = FutoPalette.N300,
    surfaceContainer = FutoPalette.InkSurface,
    surfaceContainerHigh = FutoPalette.InkHairline,
    outline = FutoPalette.N700,
    outlineVariant = FutoPalette.InkHairline,
    inverseSurface = FutoPalette.Paper,
    inverseOnSurface = FutoPalette.TextInk,
    error = FutoPalette.Danger,
)

val LocalFutoColors = staticCompositionLocalOf { FutoColors() }
val LocalFutoSpacing = staticCompositionLocalOf { FutoSpacing }

@Composable
fun FutoNotesTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    val futoColors = if (darkTheme) darkFutoColors else FutoColors()
    CompositionLocalProvider(
        LocalFutoColors provides futoColors,
    ) {
        MaterialTheme(
            colorScheme = if (darkTheme) FutoDarkColorScheme else FutoLightColorScheme,
            typography = FutoTypography,
            shapes = FutoShapes,
            content = content,
        )
    }
}

/** Convenience accessor: `FutoTheme.colors`, `FutoTheme.spacing`, `FutoTheme.radius`. */
object FutoTheme {
    val colors: FutoColors
        @Composable @ReadOnlyComposable get() = LocalFutoColors.current
    val spacing get() = FutoSpacing
    val radius get() = FutoRadius
}
