package com.futo.notes.ui.theme

import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.Easing
import androidx.compose.ui.graphics.Color

/**
 * Motion — ambient and confident. Fades and gentle slides; NO bounce, NO spring
 * overshoot, NO spin. Things ease in, settle, and stay still. Always honor the
 * system "remove animations" setting.
 *
 *   tween(durationMillis = FutoMotion.Base, easing = FutoMotion.EaseSoft)
 */
object FutoMotion {
    val EaseSoft: Easing = CubicBezierEasing(0.22f, 0.61f, 0.36f, 1f) // default ease-out
    val EaseInOut: Easing = CubicBezierEasing(0.45f, 0f, 0.15f, 1f)

    const val Fast = 140
    const val Base = 220
    const val Slow = 360
}

/** Warm-cast shadow tint — pass to Modifier.shadow(spotColor/ambientColor). */
val FutoShadowTint = Color(0xFF1A1208)
