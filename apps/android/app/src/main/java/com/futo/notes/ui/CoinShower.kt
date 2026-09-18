package com.futo.notes.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.rotateRad
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.platform.LocalDensity
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin
import kotlin.random.Random

// A hundred-odd little coins, bouncing around inside the License plate.
//
// FUTOpay's checkout page does this on a purchase (`coin-bounce.js` in
// lib-polar), @justin asked for the same moment in the app, and desktop shipped
// it 2026-09-18. This is that, in Kotlin — the same numbers and the same model:
//
//   - **Confined.** The canvas is the plate's own box and the coins bounce off
//     its four walls, so the celebration belongs to the thing being celebrated
//     rather than raining over the note list behind Settings.
//   - **No physics engine.** Ballistic motion plus a coefficient of restitution
//     is the whole model. Rigid-body contact resolution buys nothing anything
//     can see at eight dp across.
//   - **No second 3D scene.** The coin in the well is already holding a Filament
//     engine; a Compose `Canvas` costs none.
//
// It runs for a few seconds in Settings — a surface the user opened on purpose —
// and takes itself down afterwards (M5: nothing animates in the background).
//
// One concept, three shells (drift registry `supporter-coin-burst`):
// `src/features/license/coinShower.ts` and `apps/ios/Sources/License/CoinShower.swift`
// are the other two, and the constants below are theirs.

/// How many coins the burst throws. The FUTOpay page spawns one per click and
/// lets them pile up; this is the whole pile at once.
internal const val COIN_BURST_COUNT = 120

/// Pixels per second squared. Tuned against the plate's height rather than a real
/// g: what matters is that a coin thrown at the top of the plate comes back down
/// within about a second.
private const val BURST_GRAVITY = 1500f

/// Opening speed. The spread is wide on purpose — a uniform burst reads as a
/// mechanism, an uneven one as a handful of coins.
private const val BURST_SPEED_MIN = 260f
private const val BURST_SPEED_MAX = 760f

/// How much speed survives a bounce. High on purpose: the plate is only a few
/// hundred pixels tall, so a realistic 0.4 has every coin parked in under a
/// second and the whole thing reads as a pile rather than as coins bouncing.
private const val BURST_WALL_RESTITUTION = 0.62f
private const val BURST_FLOOR_RESTITUTION = 0.66f

/// Horizontal speed lost on each floor contact, so coins drift rather than
/// skating the full width forever.
private const val BURST_FLOOR_FRICTION = 0.9f

/// Below this vertical speed a coin touching its rest line is laid down rather
/// than bounced again — otherwise it buzzes at sub-pixel amplitudes forever.
private const val BURST_REST_SPEED = 55f

/// How far above the floor a coin may come to rest. Nothing here collides with
/// anything else, so without this every coin parks on the same line and 120 of
/// them read as a gold rule drawn along the bottom edge.
private const val BURST_REST_SCATTER = 26f

/// Radians per second of tumble. A coin is drawn edge-on as it passes through a
/// quarter turn, which is the whole reason it reads as a coin and not a dot.
private const val BURST_TUMBLE_MIN = 6f
private const val BURST_TUMBLE_MAX = 22f

private const val BURST_RADIUS_MIN = 5f
private const val BURST_RADIUS_MAX = 9f

/// How long the coins stay before they start to go, and how long they take.
/// Short enough that most are still in the air when the fade starts — a burst
/// that outlives its own motion is just clutter on the plate.
internal const val BURST_SETTLE_SECONDS = 2.3f
internal const val BURST_FADE_SECONDS = 0.9f

/// Frame-time clamp, the same reason the coin itself has one: a view that was off
/// screen hands back a huge first delta, and a 300ms step would teleport every
/// coin through a wall.
private const val BURST_MAX_FRAME_SECONDS = 1f / 30f

/// Gold, matching the coin in the well and the plate's accent.
private val BURST_FACE_LIGHT = Color(0xFFFFD24D)
private val BURST_FACE_DARK = Color(0xFFC8920C)
private val BURST_RIM = Color(0xFF8B6508)

/// The FUTO diamond, as a fraction of the radius — the same 0.45 the Blender
/// model and all three flat glyphs use.
private const val BURST_DIAMOND_HALF = 0.45f

/** One tumbling coin. */
internal class BurstCoin(
    var x: Float,
    var y: Float,
    var velocityX: Float,
    var velocityY: Float,
    val radius: Float,
    /**
     * Where the coin is in its tumble. `cos(phase)` is how much of its face is
     * turned toward us, so 0 is face-on and a quarter turn is edge-on.
     */
    var phase: Float,
    var tumble: Float,
    /**
     * The tilt of the spin axis in the plane, so they do not all tumble about the
     * same horizontal line.
     */
    val tilt: Float,
    /** The y this coin settles on, scattered so the heap has depth. */
    val restOffset: Float,
    var resting: Boolean = false,
)

/**
 * The burst's whole state: where every coin is and how long it has been going.
 *
 * Its arithmetic is pure and has no Compose, Canvas or GPU in it, which is what
 * `CoinShowerTest` drives on the JVM — the only way to assert that 120 coins
 * stay inside the plate and all come to rest.
 */
internal class CoinBurst(
    private val width: Float,
    private val height: Float,
    originX: Float,
    originY: Float,
    count: Int = COIN_BURST_COUNT,
    random: Random = Random.Default,
) {
    /** Everything is thrown UPWARD out of the origin: coins that started downward
     *  simply bounced once and looked like they had been dropped. */
    val coins: List<BurstCoin> = List(count) {
        val angle = random.between(Math.PI.toFloat() * 1.15f, Math.PI.toFloat() * 1.85f)
        val speed = random.between(BURST_SPEED_MIN, BURST_SPEED_MAX)
        BurstCoin(
            x = originX + random.between(-12f, 12f),
            y = originY + random.between(-12f, 12f),
            velocityX = cos(angle) * speed,
            velocityY = sin(angle) * speed,
            radius = random.between(BURST_RADIUS_MIN, BURST_RADIUS_MAX),
            phase = random.between(0f, Math.PI.toFloat() * 2f),
            tumble = random.between(BURST_TUMBLE_MIN, BURST_TUMBLE_MAX) *
                (if (random.nextBoolean()) 1f else -1f),
            tilt = random.between(-0.5f, 0.5f),
            restOffset = random.between(0f, BURST_REST_SCATTER),
        )
    }

    var elapsed = 0f
        private set

    /** True once every coin has faded out and there is nothing left to draw. */
    val finished: Boolean get() = elapsed >= BURST_SETTLE_SECONDS + BURST_FADE_SECONDS

    /** How opaque the whole burst is: solid until it settles, then fading. */
    val opacity: Float
        get() = if (elapsed <= BURST_SETTLE_SECONDS) {
            1f
        } else {
            max(0f, 1f - (elapsed - BURST_SETTLE_SECONDS) / BURST_FADE_SECONDS)
        }

    fun advance(seconds: Float) {
        val step = min(seconds, BURST_MAX_FRAME_SECONDS)
        elapsed += step
        for (coin in coins) advance(coin, step)
    }

    private fun advance(coin: BurstCoin, seconds: Float) {
        if (!coin.resting) {
            coin.velocityY += BURST_GRAVITY * seconds
            coin.x += coin.velocityX * seconds
            coin.y += coin.velocityY * seconds
            coin.phase += coin.tumble * seconds
        }

        // Walls. Position is corrected as well as velocity, so a coin that
        // overshot in one step cannot be caught outside and bounced every frame.
        if (coin.x - coin.radius < 0f) {
            coin.x = coin.radius
            coin.velocityX = abs(coin.velocityX) * BURST_WALL_RESTITUTION
        } else if (coin.x + coin.radius > width) {
            coin.x = width - coin.radius
            coin.velocityX = -abs(coin.velocityX) * BURST_WALL_RESTITUTION
        }
        if (coin.y - coin.radius < 0f) {
            coin.y = coin.radius
            coin.velocityY = abs(coin.velocityY) * BURST_WALL_RESTITUTION
        }

        val floor = height - coin.radius - coin.restOffset
        if (coin.y >= floor) {
            coin.y = floor
            if (abs(coin.velocityY) < BURST_REST_SPEED) {
                // Laid flat, face up, and left alone.
                coin.resting = true
                coin.velocityX = 0f
                coin.velocityY = 0f
                coin.phase = 0f
            } else {
                coin.velocityY = -abs(coin.velocityY) * BURST_FLOOR_RESTITUTION
                coin.velocityX *= BURST_FLOOR_FRICTION
                coin.tumble *= BURST_FLOOR_FRICTION
            }
        }
    }
}

private fun Random.between(min: Float, max: Float) = min + nextFloat() * (max - min)

/**
 * The burst, drawn on the plate.
 *
 * It fills whatever box [modifier] gives it and bounces its coins off that box's
 * walls, so "inside the plate" is structural rather than something a screenshot
 * has to judge. [onFinished] fires once the last coin has faded, so the plate can
 * drop this composable and stop drawing entirely (M5).
 */
@Composable
internal fun CoinShower(
    /** How far down the plate the coins come from. Horizontally they start at the
     *  middle, which is where the well — and the coin just earned — sits. */
    originY: Float,
    onFinished: () -> Unit,
    modifier: Modifier = Modifier,
) {
    // `BoxWithConstraints` so the box the coins bounce inside is known during
    // composition: the burst has to be built with its walls, and building it
    // from inside the draw would mean writing state while painting.
    BoxWithConstraints(modifier) {
        val density = LocalDensity.current
        val width = with(density) { maxWidth.toPx() }
        val height = with(density) { maxHeight.toPx() }
        val burst = remember(width, height) {
            CoinBurst(
                width = width,
                height = height,
                originX = width / 2f,
                originY = min(originY, height),
            )
        }
        // The coins move in place; what the canvas needs is a reason to redraw.
        var frame by remember(burst) { mutableIntStateOf(0) }

        LaunchedEffect(burst) {
            var last = 0L
            while (!burst.finished) {
                withFrameNanos { now ->
                    val seconds = if (last == 0L) 0f else (now - last) / 1_000_000_000f
                    last = now
                    burst.advance(seconds)
                    frame++
                }
            }
            onFinished()
        }

        Canvas(Modifier.matchParentSize()) {
            // Read so the canvas redraws every frame the loop above advances.
            @Suppress("UNUSED_EXPRESSION")
            frame
            for (coin in burst.coins) paint(coin, burst.opacity)
        }
    }
}

/**
 * `cos(phase)` is how much of the face is turned toward us. Squashing the disc by
 * it is the whole tumble: at a quarter turn the coin is a line, and what is left
 * is its rim.
 */
private fun DrawScope.paint(coin: BurstCoin, opacity: Float) {
    val facing = abs(cos(coin.phase))
    translate(coin.x, coin.y) {
        rotateRad(coin.tilt, pivot = Offset.Zero) {
            // The rim, drawn first and slightly proud of the face, so an edge-on
            // coin is a bright gold sliver rather than nothing at all.
            val rimHeight = max(coin.radius * facing, 0.6f)
            drawOval(
                color = BURST_RIM,
                topLeft = Offset(-coin.radius, -rimHeight),
                size = Size(coin.radius * 2f, rimHeight * 2f),
                alpha = opacity,
            )

            if (facing > 0.12f) {
                val faceWidth = coin.radius * 0.88f
                val faceHeight = coin.radius * facing * 0.88f
                drawOval(
                    brush = Brush.linearGradient(
                        colors = listOf(BURST_FACE_LIGHT, BURST_FACE_DARK),
                        start = Offset(-coin.radius, -coin.radius),
                        end = Offset(coin.radius, coin.radius),
                    ),
                    topLeft = Offset(-faceWidth, -faceHeight),
                    size = Size(faceWidth * 2f, faceHeight * 2f),
                    alpha = opacity,
                )

                // The FUTO diamond. Shaded rather than punched: a real hole would
                // have to show whatever is behind this coin, and at eight pixels
                // across a dark recess reads the same and costs one path.
                val half = coin.radius * BURST_DIAMOND_HALF
                val diamond = Path().apply {
                    moveTo(0f, -half * facing)
                    lineTo(half, 0f)
                    lineTo(0f, half * facing)
                    lineTo(-half, 0f)
                    close()
                }
                drawPath(diamond, color = BURST_RIM, alpha = opacity)
            }
        }
    }
}
