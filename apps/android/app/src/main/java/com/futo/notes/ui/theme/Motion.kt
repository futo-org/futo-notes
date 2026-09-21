package com.futo.notes.ui.theme

import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.Easing

object FutoMotion {
    val EaseSoft: Easing = CubicBezierEasing(0.22f, 0.61f, 0.36f, 1f) // default ease-out

    const val Fast = 140
    const val Base = 220
}
