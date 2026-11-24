package com.futo.notes.textfirst

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.graphics.toArgb
import com.futo.notes.ui.theme.FutoColors
import com.futo.notes.ui.theme.FutoPalette

/** The note's colours follow the theme: a light/dark switch repaints the open note. */
@Composable
internal fun TextFirstColors(controller: TextFirstController, c: FutoColors, darkTheme: Boolean) {
    LaunchedEffect(controller, c, darkTheme) {
        controller.updateColors(
            text = c.textPrimary.toArgb(),
            muted = c.textMuted.toArgb(),
            link = c.accent.toArgb(),
            border = c.border.toArgb(),
            code = (if (darkTheme) FutoPalette.InkHairline else FutoPalette.N200).toArgb(),
            surface = c.surfaceSunken.toArgb(),
            page = c.surface.toArgb(),
            danger = c.danger.toArgb(),
        )
    }
}
