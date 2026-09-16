package com.futo.notes.ui

import android.provider.Settings
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.State
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.withTransform
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathOperation
import androidx.compose.ui.graphics.painter.Painter
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.rememberVectorPainter
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.vectorResource
import androidx.compose.ui.unit.Dp
import com.futo.notes.R
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.sin

/// Geometry, as fractions of the coin's box, from `supporterCoin.ts`: the disc is
/// radius 22 in a 48 box and the extrusion is a sixth of that radius.
internal const val DISC_RADIUS_FRACTION = 22f / 48f
internal const val DEPTH_FRACTION = (22f / 6f) / 48f

/// One turn every ~5s — `BASE_SPIN` (1.25 rad/s) in desktop's units. Slow enough
/// to read as an object rather than a spinner.
private const val TURN_MILLIS = 5027

/// How dark the face goes as it turns away. Metal edge-on catches almost no key
/// light, and without this the coin reads as a flat sticker being rotated.
private const val EDGE_ON_SHADE = 0.40f

/// Never let the squeeze reach zero, or the coin vanishes outright on the frame
/// it passes through edge-on.
internal const val MIN_SQUEEZE = 0.04f

/// A quarter turn short of face-on, so a still coin still shows a sliver of rim
/// and reads as a solid object rather than a decal.
private const val RESTING_TURN = 0.35f

/// Rim gold — `RIM_COLOR` in `supporterCoin.ts`.
private val RIM_GOLD = Color(0xFFB8860B)

/**
 * The FUTO supporter coin, turning on its spindle, [diameter] across.
 *
 * Desktop renders this coin in three.js (`src/features/license/supporterCoin.ts`)
 * — an extruded disc with the FUTO diamond punched through it, gold face over a
 * darker rim. Android cannot afford a 3D engine for one Settings ornament, so this
 * draws the SAME object by projecting it instead of modelling it, and the SwiftUI
 * `SupporterCoin` does the identical arithmetic on iOS.
 *
 * The projection is the whole trick. An extruded disc of radius R and depth d,
 * turned by θ about its vertical axis, lands on screen as two copies of the flat
 * glyph: the far face at horizontal offset −(d·sinθ)/2 and the near face at
 * +(d·sinθ)/2, both squeezed horizontally to |cosθ|. Draw the far one in rim gold
 * and the near one in face gold and the coin has a rim, an inner wall inside the
 * diamond, and a silhouette that narrows to an edge — all of it for the cost of
 * drawing one vector drawable twice.
 *
 * `ic_supporter_coin` is that glyph and the ONLY art here: no path is restated in
 * Kotlin, so the `supporter-coin-glyph` drift entry still has exactly its three
 * registered copies.
 *
 * The angle is read in the DRAW scope, never in composition. That is what keeps a
 * permanently-running animation off the recomposer: each frame invalidates one
 * drawing rather than a subtree. Settings is not the editor, but M5's rule is that
 * unrequested animation stays as cheap as it can be made.
 *
 * Holds still — as a whole, correct coin, not a placeholder — when the system
 * animator scale is zero. That is Android's "I do not want unrequested motion"
 * switch, and it is the same answer desktop gives `prefers-reduced-motion`.
 */
@Composable
fun SupporterCoin(diameter: Dp, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    // Read once: this is a system setting, not something that changes under the
    // user mid-sheet.
    val animates = remember {
        Settings.Global.getFloat(
            context.contentResolver,
            Settings.Global.ANIMATOR_DURATION_SCALE,
            1f,
        ) != 0f
    }

    val turn: State<Float> =
        if (animates) {
            rememberInfiniteTransition(label = "supporter-coin").animateFloat(
                initialValue = 0f,
                targetValue = (2 * Math.PI).toFloat(),
                animationSpec = infiniteRepeatable(
                    // Linear: a coin on a spindle has no ease. Restart rather than
                    // Reverse, or it would visibly rock instead of turn.
                    animation = tween(TURN_MILLIS, easing = LinearEasing),
                    repeatMode = RepeatMode.Restart,
                ),
                label = "supporter-coin-turn",
            )
        } else {
            remember { mutableFloatStateOf(RESTING_TURN) }
        }

    val glyph = rememberVectorPainter(ImageVector.vectorResource(R.drawable.ic_supporter_coin))

    Canvas(modifier.size(diameter)) {
        val theta = turn.value
        val cosine = cos(theta)
        val sine = sin(theta)
        val squeeze = maxOf(abs(cosine), MIN_SQUEEZE)
        val halfWidth = faceHalfWidth(size.width, squeeze)
        val halfHeight = size.height * DISC_RADIUS_FRACTION
        val halfGap = halfSeparation(size.width, sine)

        // The extruded wall: the strip of the coin's edge that is visible between
        // the two faces. Its shape is the convex hull of the two face ellipses
        // MINUS the faces themselves — which is to say, exactly the part of the
        // silhouette neither face covers. Drawing the two faces alone leaves that
        // part empty, and the coin looks pinched at top and bottom, as if the two
        // faces were floating apart with nothing joining them.
        //
        // Subtracting the faces is what keeps the diamond a hole. The leftover
        // slivers sit at the silhouette's vertical extremes, nowhere near the
        // centre — until the coin is within about 5° of edge-on, where the faces
        // are narrower than the gap and the wall does reach the middle. That is
        // not a flaw: looking along a through-hole, you cannot see through it.
        withTransform({ translate(center.x, center.y) }) {
            drawPath(extrudedWall(halfWidth, halfHeight, halfGap), RIM_GOLD)
        }

        // The far face, flat rim gold: what shows past the near face is the rim,
        // and what shows inside the diamond is the hole's inner wall. Drawing both
        // faces also gives the hole its correct opening for free — a pixel is
        // clear only where BOTH faces are clear, which is the intersection of the
        // two projected diamonds, which is what you actually see through.
        drawFace(glyph, squeeze, -halfGap, ColorFilter.tint(RIM_GOLD))

        // The near face, keeping the glyph's own gold gradient. SrcAtop shades
        // only where the coin is, so the diamond stays a hole rather than filling
        // with a darkened square.
        drawFace(
            glyph,
            squeeze,
            halfGap,
            ColorFilter.tint(
                Color.Black.copy(alpha = (1f - abs(cosine)) * EDGE_ON_SHADE),
                BlendMode.SrcAtop,
            ),
        )
    }
}

/// Half the width of one projected face, in pixels.
internal fun faceHalfWidth(boxWidth: Float, squeeze: Float): Float =
    boxWidth * DISC_RADIUS_FRACTION * squeeze

/// Half the horizontal gap between the two faces, in pixels — the projection of
/// the coin's thickness, and so the width of its edge seen side-on.
internal fun halfSeparation(boxWidth: Float, sine: Float): Float =
    boxWidth * DEPTH_FRACTION * sine / 2f

/// The band between the two faces with both faces cut out of it.
///
/// That band IS the hull of the two face ellipses minus their union: the hull is
/// the two ellipses plus the rectangle spanning the gap (at the very top and
/// bottom each ellipse is a single point, and the rectangle's edge runs exactly
/// between them), so subtracting the ellipses leaves the rectangle minus the
/// ellipses and nothing else. Empty when the coin is face-on, which is correct —
/// there is no edge to see then.
private fun extrudedWall(halfWidth: Float, halfHeight: Float, halfGap: Float): Path {
    val gap = abs(halfGap)
    val band = Path().apply { addRect(Rect(-gap, -halfHeight, gap, halfHeight)) }
    val faces = Path().apply {
        addOval(Rect(gap - halfWidth, -halfHeight, gap + halfWidth, halfHeight))
        addOval(Rect(-gap - halfWidth, -halfHeight, -gap + halfWidth, halfHeight))
    }
    return Path().apply { op(band, faces, PathOperation.Difference) }
}

/// One projected face: the glyph squeezed horizontally about the centre, then
/// shifted. The order matters — scaling first and translating second keeps
/// [offsetX] a screen-space gap rather than one the squeeze shrinks along with
/// everything else, and that gap IS the coin's thickness.
private fun DrawScope.drawFace(
    glyph: Painter,
    squeeze: Float,
    offsetX: Float,
    colorFilter: ColorFilter,
) {
    withTransform({
        translate(offsetX, 0f)
        scale(squeeze, 1f, pivot = center)
    }) {
        with(glyph) { draw(size = this@drawFace.size, colorFilter = colorFilter) }
    }
}
