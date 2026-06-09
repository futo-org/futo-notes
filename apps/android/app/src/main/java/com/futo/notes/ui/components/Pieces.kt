package com.futo.notes.ui.components

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.interaction.InteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.futo.notes.ui.theme.FutoMotion
import com.futo.notes.ui.theme.FutoRadius
import com.futo.notes.ui.theme.FutoType
import com.futo.notes.ui.theme.FutoTheme

/** Uppercase "micro" section label (e.g. PINNED, NOTES, RELATED NOTES). */
@Composable
fun MicroLabel(text: String, modifier: Modifier = Modifier) {
    Text(
        text = text.uppercase(),
        style = FutoType.micro,
        color = FutoTheme.colors.textMuted,
        modifier = modifier,
    )
}

/** A "#tag" pill on a sunken surface. */
@Composable
fun TagPill(tag: String, modifier: Modifier = Modifier) {
    Surface(
        color = FutoTheme.colors.surfaceSunken,
        contentColor = FutoTheme.colors.textTertiary,
        shape = RoundedCornerShape(FutoRadius.pill),
        modifier = modifier,
    ) {
        Text(
            text = "#$tag",
            style = FutoType.caption,
            color = FutoTheme.colors.textTertiary,
            modifier = Modifier.padding(horizontal = 8.dp, vertical = 2.dp),
        )
    }
}

/**
 * Press feedback: smoothly scale toward [pressedScale] while pressed
 * (0.99f cards, 0.97f buttons/FAB) over [FutoMotion.Fast] with EaseSoft. No
 * scale-UP, ever. Apply the returned value via Modifier.graphicsLayer.
 */
@Composable
fun pressScale(interactionSource: InteractionSource, pressedScale: Float = 0.97f): Float {
    val pressed by interactionSource.collectIsPressedAsState()
    val scale by animateFloatAsState(
        targetValue = if (pressed) pressedScale else 1f,
        animationSpec = tween(durationMillis = FutoMotion.Fast, easing = FutoMotion.EaseSoft),
        label = "pressScale",
    )
    return scale
}
