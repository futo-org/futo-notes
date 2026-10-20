package com.futo.notes.ui

import android.provider.Settings
import androidx.compose.foundation.Image
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.PointerInputChange
import androidx.compose.ui.input.pointer.changedToUpIgnoreConsumed
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.viewinterop.AndroidView
import com.futo.notes.R
import kotlin.math.abs

/// The coin and the studio it reflects, both exported by assets/coin/build-coin.py
/// and staged into the APK's assets by the app's Gradle script.
internal const val FLAT_COIN_TAG = "supporter-coin-flat"

/// The live 3D surface, tagged so a test can tell the two coins apart — the
/// flat glyph is gold too, so "it looks like a coin" does not say which one
/// drew it. Desktop marks the same distinction with `.supporter-coin-stage-live`.
internal const val LIVE_COIN_TAG = "supporter-coin-live"

internal const val MODEL_ASSET = "futo-coin.glb"
internal const val ENVIRONMENT_ASSET = "studio-env-ibl.ktx"

/// Slow enough to read as an object rather than a spinner: one turn every ~5s.
/// The same number desktop uses, in the same units.
internal const val BASE_SPIN = 1.25f

/// How fast any departure from the resting speed — a flick — bleeds off.
internal const val SPIN_DECAY = 2.6f

/// Radians of turn per density-independent pixel dragged. Desktop's constant is
/// per CSS pixel, and a dp is the same apparent size, so the coin turns the same
/// amount under the same thumb travel on both.
private const val DRAG_RADIANS_PER_DP = 0.018f

/// A flick is only a flick if the pointer was still moving when it left. Below
/// this the coin is *placed*, and stays where it was put.
private const val FLICK_MIN_SPEED = 0.6f

/// Ceiling on a thrown spin, so a fast swipe cannot turn the coin into a strobe.
private const val FLICK_MAX_SPEED = 24f

/// A fixed tilt, so the coin reads as a disc even at the instant its face is
/// edge-on to the camera. Desktop and iOS apply the same angle.
internal const val TILT_X = 0.24f

/**
 * The FUTO supporter coin, turning on its spindle, [diameter] across.
 *
 * This renders the SAME object desktop and iOS render: `assets/coin/futo-coin.glb`,
 * modelled once in Blender, lit by `studio-env-ibl.ktx` — the studio from the same
 * script, prefiltered for Filament by `scripts/build-coin-ibl.mjs`. Nothing about
 * the coin's shape or its materials is written in Kotlin; this file only frames it,
 * turns it and hands it to the GPU.
 *
 * That replaces a 2D projection which drew the flat glyph twice to fake an extruded
 * disc. The projection was clever and cost nothing, but it could not light metal:
 * gold reflects its surroundings, and a shape with a gradient painted on it reads as
 * a sticker no matter how correctly it is squeezed.
 *
 * Drag it and it turns under your thumb; let go while moving and it spins on. Tap
 * it and it turns once around, fast, on top of whatever it was already doing —
 * and taps QUEUE, so ten taps are ten turns. It
 * holds still — as a whole, correct coin, not a placeholder — when the system
 * animator scale is zero, which is Android's "I do not want unrequested motion"
 * switch and the same answer desktop gives `prefers-reduced-motion`.
 *
 * If Filament cannot start — no usable GL context, or a driver whose compiler
 * Filament's own shaders would die on ([FilamentSupport]) — the flat glyph is
 * what shows. It is a whole coin too, just a still one.
 */
@Composable
fun SupporterCoin(
    diameter: Dp,
    modifier: Modifier = Modifier,
    /// Whether this device's GL can run Filament at all. A parameter only so a
    /// test can render the refusal on a device that is perfectly capable;
    /// nothing in the app passes it.
    glCanRunFilament: Boolean = LocalContext.current.let { context ->
        remember(context) { FilamentSupport.canRender(context) }
    },
) {
    val context = LocalContext.current
    val density = LocalDensity.current.density
    // Read once: this is a system setting, not something that changes under the
    // user mid-sheet.
    val animates = remember {
        Settings.Global.getFloat(
            context.contentResolver,
            Settings.Global.ANIMATOR_DURATION_SCALE,
            1f,
        ) != 0f
    }

    // The surface is created here rather than in AndroidView's factory so this
    // composable holds the only reference to it. The scene needs that exact
    // view, and reaching into the view tree to find it would break the moment
    // Compose changed how it wraps an AndroidView.
    val surface = remember(glCanRunFilament) {
        if (glCanRunFilament) runCatching { FilamentRuntime.surface(context) }.getOrNull() else null
    }
    var scene by remember { mutableStateOf<CoinScene?>(null) }
    var failed by remember { mutableStateOf(surface == null) }

    DisposableEffect(surface, animates) {
        if (surface == null) {
            onDispose { }
        } else {
            // Recorded before Filament is handed the surface, and cleared by
            // the scene's first returned frame. A device where that frame never
            // comes back gets the flat coin from its third launch on, which is
            // the only fallback available for a renderer that aborts the
            // process instead of failing ([FilamentSupport]).
            FilamentSupport.beginRenderAttempt(context)
            val built = runCatching { CoinScene(context, surface, animates) }
            val live = built.getOrNull()
            if (live == null) failed = true else scene = live
            onDispose {
                scene = null
                live?.destroy()
            }
        }
    }

    Box(modifier.size(diameter)) {
        if (failed || surface == null) {
            // A whole coin, just a still one. Reached when this device cannot
            // give Filament a GL context at all, or gives it one whose compiler
            // Filament would abort the process over ([FilamentSupport]) — and
            // it is also the only state the old projection-based coin could
            // ever be in.
            Image(
                painter = painterResource(R.drawable.ic_supporter_coin),
                contentDescription = null,
                modifier = Modifier
                    .fillMaxSize()
                    .testTag(FLAT_COIN_TAG),
            )
        } else {
            AndroidView(
                factory = { surface },
                modifier = Modifier
                    .fillMaxSize()
                    .testTag(LIVE_COIN_TAG)
                    // Keyed on the scene so the gesture is re-established once it
                    // exists; before that there is nothing to turn.
                    .pointerInput(scene) {
                        val live = scene ?: return@pointerInput
                        // Velocity is smoothed: a single sample is noisy enough
                        // to throw a wild flick off the last two pixels of an
                        // otherwise slow drag.
                        var velocity = 0f
                        var lastAt = 0L
                        // Horizontal only, so a vertical swipe still scrolls the
                        // Settings sheet under the finger. Claiming the whole
                        // gesture would trap the scroll on a phone.
                        detectHorizontalDragGestures(
                            onDragStart = {
                                velocity = 0f
                                lastAt = System.nanoTime()
                                live.grab()
                            },
                            onDragEnd = {
                                live.release(
                                    if (abs(velocity) > FLICK_MIN_SPEED) {
                                        velocity.coerceIn(-FLICK_MAX_SPEED, FLICK_MAX_SPEED)
                                    } else {
                                        null
                                    },
                                )
                            },
                            onDragCancel = { live.release(null) },
                        ) { change, dragAmount ->
                            change.consume()
                            val now = System.nanoTime()
                            val seconds = (now - lastAt) / 1_000_000_000f
                            lastAt = now
                            val radians = dragAmount / density * DRAG_RADIANS_PER_DP
                            live.turnBy(radians)
                            if (seconds > 0f) {
                                velocity = velocity * 0.7f + (radians / seconds) * 0.3f
                            }
                        }
                    }
                    // A tap is a drag that went nowhere, so it is read from the
                    // same touch rather than from a second gesture definition.
                    // Its own `pointerInput` on the FINAL pass: the drag
                    // detector above gets the events first and consumes what it
                    // claims, and this only ever watches.
                    .pointerInput(scene) {
                        val live = scene ?: return@pointerInput
                        val slop = TAP_MAX_MOVEMENT_DP * density
                        awaitEachGesture {
                            val down = awaitFirstDown(requireUnconsumed = false)
                            var travelled = 0f
                            var last = down.position
                            var released: PointerInputChange? = null
                            while (true) {
                                val event = awaitPointerEvent(PointerEventPass.Final)
                                val change =
                                    event.changes.firstOrNull { it.id == down.id } ?: break
                                travelled += (change.position - last).getDistance()
                                last = change.position
                                if (change.changedToUpIgnoreConsumed()) {
                                    released = change
                                    break
                                }
                            }
                            val up = released ?: return@awaitEachGesture
                            val held = up.uptimeMillis - down.uptimeMillis
                            if (travelled <= slop && held <= TAP_MAX_MILLISECONDS) live.tap()
                        }
                    },
            )
        }
    }
}
