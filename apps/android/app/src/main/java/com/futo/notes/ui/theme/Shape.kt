package com.futo.notes.ui.theme

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Shapes
import androidx.compose.ui.unit.dp

object FutoRadius {
    val xs = 6.dp
    val sm = 10.dp
    val md = 12.dp
    val lg = 16.dp
    val xl = 22.dp
    val pill = 999.dp
}

val FutoShapes = Shapes(
    extraSmall = RoundedCornerShape(FutoRadius.xs),
    small = RoundedCornerShape(FutoRadius.sm),
    medium = RoundedCornerShape(FutoRadius.md),
    large = RoundedCornerShape(FutoRadius.lg),
    extraLarge = RoundedCornerShape(FutoRadius.xl),
)
