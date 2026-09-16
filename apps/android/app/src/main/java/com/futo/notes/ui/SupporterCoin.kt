package com.futo.notes.ui

import android.content.Context
import android.provider.Settings
import android.view.Choreographer
import android.view.TextureView
import androidx.compose.foundation.Image
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
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.viewinterop.AndroidView
import com.futo.notes.R
import com.google.android.filament.Camera
import com.google.android.filament.ColorGrading
import com.google.android.filament.Engine
import com.google.android.filament.EntityManager
import com.google.android.filament.IndirectLight
import com.google.android.filament.Renderer
import com.google.android.filament.Scene
import com.google.android.filament.SwapChain
import com.google.android.filament.ToneMapper
import com.google.android.filament.View as FilamentView
import com.google.android.filament.Viewport
import com.google.android.filament.android.UiHelper
import com.google.android.filament.gltfio.AssetLoader
import com.google.android.filament.gltfio.FilamentAsset
import com.google.android.filament.gltfio.ResourceLoader
import com.google.android.filament.gltfio.UbershaderProvider
import com.google.android.filament.utils.KTX1Loader
import com.google.android.filament.utils.Utils
import java.nio.ByteBuffer
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.sin

/// The coin and the studio it reflects, both exported by assets/coin/build-coin.py
/// and staged into the APK's assets by the app's Gradle script.
private const val MODEL_ASSET = "futo-coin.glb"
private const val ENVIRONMENT_ASSET = "studio-env-ibl.ktx"

/// Slow enough to read as an object rather than a spinner: one turn every ~5s.
/// The same number desktop uses, in the same units.
private const val BASE_SPIN = 1.25f

/// How fast any departure from the resting speed — a flick — bleeds off.
private const val SPIN_DECAY = 2.6f

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
private const val TILT_X = 0.24f

/// The camera. A 30 degree vertical field of view at this distance frames the
/// model's 0.7 diameter at about 84% of the box, leaving room for the corners as
/// it turns — the same framing as desktop.
private const val CAMERA_FOV_DEGREES = 30.0
private const val CAMERA_DISTANCE = 1.55

/// A neutral exposure multiplier, so [IBL_INTENSITY] is the only place the coin's
/// brightness is decided.
/// Frame-time clamp. A view that was off screen hands back a huge delta on its
/// first frame; without this the coin jumps a random fraction of a turn.
private const val MAX_FRAME_SECONDS = 1f / 20f

/// How hard the studio lights the coin.
///
/// This is NOT 1.0, and the reason is worth writing down: Filament's indirect
/// light intensity is a physical quantity (lux) applied on top of a cubemap that
/// cmgen has already normalised, whereas three.js multiplies the environment's
/// own values straight into the shading. So the same studio, honestly converted,
/// arrives about four times dimmer here — the first Android render was a deep
/// bronze next to desktop's gold, at identical geometry and materials.
///
/// 4.5 is measured, not guessed: it is the value at which the mean colour of the
/// coin's gold pixels matches the desktop renderer's to within a few points per
/// channel. Change the studio in build-coin.py and this wants re-measuring.
private const val IBL_INTENSITY = 4.5f
private const val CAMERA_EXPOSURE = 1.0f

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
 * Drag it and it turns under your thumb; let go while moving and it spins on. It
 * holds still — as a whole, correct coin, not a placeholder — when the system
 * animator scale is zero, which is Android's "I do not want unrequested motion"
 * switch and the same answer desktop gives `prefers-reduced-motion`.
 *
 * If Filament cannot start (no usable GL context), the flat glyph is what shows.
 * It is a whole coin too, just a still one.
 */
@Composable
fun SupporterCoin(diameter: Dp, modifier: Modifier = Modifier) {
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
    val surface = remember { runCatching { FilamentRuntime.surface(context) }.getOrNull() }
    var scene by remember { mutableStateOf<CoinScene?>(null) }
    var failed by remember { mutableStateOf(surface == null) }

    DisposableEffect(surface, animates) {
        if (surface == null) {
            onDispose { }
        } else {
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
            // give Filament a GL context at all, which is also the only state
            // the old projection-based coin could ever be in.
            Image(
                painter = painterResource(R.drawable.ic_supporter_coin),
                contentDescription = null,
                modifier = Modifier.fillMaxSize(),
            )
        } else {
            AndroidView(
                factory = { surface },
                modifier = Modifier
                    .fillMaxSize()
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
                    },
            )
        }
    }
}

/**
 * One coin: a Filament engine, the loaded model, the environment that lights it,
 * and the frame loop that turns it.
 *
 * Everything here is native memory. Filament tracks none of it for you, and a
 * Settings sheet that is opened and closed all day would leak an engine per visit,
 * so [destroy] frees it in the order Filament requires — the asset before the
 * loader that made it, the swap chain before the engine.
 */
private class CoinScene(
    context: Context,
    textureView: TextureView,
    private val animates: Boolean,
) {
    private val engine = Engine.create()
    private val renderer = engine.createRenderer()
    private val scene: Scene = engine.createScene()
    private val filamentView: FilamentView = engine.createView()
    private val cameraEntity = EntityManager.get().create()
    private val camera: Camera = engine.createCamera(cameraEntity)
    private val materialProvider = UbershaderProvider(engine)
    private val assetLoader = AssetLoader(engine, materialProvider, EntityManager.get())
    private val asset: FilamentAsset
    private val indirectLight: IndirectLight
    // Khronos PBR Neutral, not Filament's default ACES. ACES pushes a bright
    // saturated highlight toward white, and on this coin that turns the gold
    // sheen into a pale smear exactly where it should be most golden — the
    // first Android render came out looking like brushed aluminium. Desktop's
    // three.js renderer is set to the same tone mapper, which is what keeps the
    // two shells showing the same METAL and not just the same shape.
    private val colorGrading = ColorGrading.Builder()
        .toneMapper(ToneMapper.PBRNeutralToneMapper())
        .build(engine)
    private val uiHelper = UiHelper(UiHelper.ContextErrorPolicy.DONT_CHECK)
    private val choreographer = Choreographer.getInstance()

    private var swapChain: SwapChain? = null
    private var turn = 0f
    private var spin = if (animates) BASE_SPIN else 0f
    private var dragging = false
    private var lastFrameNanos = 0L
    private var destroyed = false

    private val frameCallback = object : Choreographer.FrameCallback {
        override fun doFrame(frameTimeNanos: Long) {
            if (destroyed) return
            choreographer.postFrameCallback(this)

            val elapsed = if (lastFrameNanos == 0L) {
                0f
            } else {
                ((frameTimeNanos - lastFrameNanos) / 1_000_000_000f).coerceAtMost(MAX_FRAME_SECONDS)
            }
            lastFrameNanos = frameTimeNanos

            // While a finger is down the pointer owns the angle outright: the coin
            // tracks the hand exactly rather than being nudged by a velocity,
            // which is what makes it feel like an object and not a dial.
            if (!dragging) {
                val rest = if (animates) BASE_SPIN else 0f
                // Eases in from either side, so a backwards flick settles as
                // gracefully as a forwards one.
                spin = rest + (spin - rest) * exp(-SPIN_DECAY * elapsed)
                turn += spin * elapsed
                applyTurn()
            }

            val chain = swapChain
            if (chain != null && uiHelper.isReadyToRender) {
                if (renderer.beginFrame(chain, frameTimeNanos)) {
                    renderer.render(filamentView)
                    renderer.endFrame()
                }
            }
        }
    }

    init {
        asset = context.assets.open(MODEL_ASSET).use { stream ->
            val bytes = stream.readBytes()
            val buffer = ByteBuffer.allocateDirect(bytes.size).put(bytes).apply { rewind() }
            requireNotNull(assetLoader.createAsset(buffer)) { "futo-coin.glb failed to parse" }
        }
        val resourceLoader = ResourceLoader(engine)
        try {
            resourceLoader.loadResources(asset)
        } finally {
            resourceLoader.destroy()
        }
        // The glTF's own buffers are on the GPU now; the parsed copy is dead
        // weight and gltfio will not drop it for us.
        asset.releaseSourceData()
        scene.addEntities(asset.entities)

        indirectLight = context.assets.open(ENVIRONMENT_ASSET).use { stream ->
            val bytes = stream.readBytes()
            val buffer = ByteBuffer.allocateDirect(bytes.size).put(bytes).apply { rewind() }
            requireNotNull(KTX1Loader.createIndirectLight(engine, buffer).indirectLight) {
                "studio-env-ibl.ktx carries no indirect light"
            }
        }
        indirectLight.intensity = IBL_INTENSITY
        // The environment IS the lighting: no directional or ambient light is
        // added. Every highlight on the coin is a reflection of studio-env.hdr.
        scene.indirectLight = indirectLight
        // No skybox. The coin is composited onto the app's card, so anything
        // behind it must stay transparent.
        scene.skybox = null

        filamentView.scene = scene
        filamentView.camera = camera
        // TRANSLUCENT, not the default OPAQUE: the card shows through everywhere
        // the coin is not, including through the diamond.
        filamentView.blendMode = FilamentView.BlendMode.TRANSLUCENT
        filamentView.isPostProcessingEnabled = true
        filamentView.antiAliasing = FilamentView.AntiAliasing.FXAA
        filamentView.colorGrading = colorGrading

        renderer.clearOptions = Renderer.ClearOptions().apply {
            clear = true
            clearColor = doubleArrayOf(0.0, 0.0, 0.0, 0.0)
        }

        camera.lookAt(0.0, 0.0, CAMERA_DISTANCE, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0)
        // A neutral exposure rather than a photographic one. Filament's default
        // camera is set up for daylight (f/16, 1/125s, ISO 100), which would make
        // an environment written in small absolute numbers render black.
        camera.setExposure(CAMERA_EXPOSURE)

        uiHelper.isOpaque = false
        uiHelper.renderCallback = object : UiHelper.RendererCallback {
            override fun onNativeWindowChanged(surface: android.view.Surface) {
                swapChain?.let(engine::destroySwapChain)
                swapChain = engine.createSwapChain(surface, uiHelper.swapChainFlags)
            }

            override fun onDetachedFromSurface() {
                swapChain?.let {
                    engine.destroySwapChain(it)
                    // The engine must be done with the chain before it is freed.
                    engine.flushAndWait()
                    swapChain = null
                }
            }

            override fun onResized(width: Int, height: Int) {
                filamentView.viewport = Viewport(0, 0, width, height)
                // A box that is not square keeps the coin round and centred
                // rather than stretching it: the camera always frames the SHORTER
                // side, widening the vertical angle when the box is tall.
                val aspect = width.toDouble() / height.toDouble()
                val vertical = if (aspect >= 1.0) {
                    CAMERA_FOV_DEGREES
                } else {
                    Math.toDegrees(
                        2.0 * kotlin.math.atan(
                            kotlin.math.tan(Math.toRadians(CAMERA_FOV_DEGREES) / 2.0) / aspect,
                        ),
                    )
                }
                camera.setProjection(vertical, aspect, 0.1, 10.0, Camera.Fov.VERTICAL)
            }
        }
        uiHelper.attachTo(textureView)

        applyTurn()
        choreographer.postFrameCallback(frameCallback)
    }

    fun grab() {
        dragging = true
    }

    fun turnBy(radians: Float) {
        turn += radians
        applyTurn()
    }

    /// [thrown] is null when the pointer was resting as it lifted: the coin was
    /// placed, and eases back to its resting speed from wherever it was put.
    fun release(thrown: Float?) {
        dragging = false
        spin = thrown ?: (if (animates) BASE_SPIN else 0f)
    }

    /// Writes the current angle onto the model's root.
    ///
    /// The root is gltfio's own parent above the glTF's nodes, so this is the
    /// pivot: the exported node carries its own rotation (the coin is authored
    /// lying down and stood up on export), and turning THAT would tumble the coin
    /// end over end instead of spinning it on its spindle.
    private fun applyTurn() {
        val transforms = engine.transformManager
        transforms.setTransform(transforms.getInstance(asset.root), tiltedSpin(TILT_X, turn))
    }

    fun destroy() {
        if (destroyed) return
        destroyed = true
        choreographer.removeFrameCallback(frameCallback)
        uiHelper.detach()

        scene.removeEntities(asset.entities)
        assetLoader.destroyAsset(asset)
        materialProvider.destroyMaterials()
        assetLoader.destroy()
        engine.destroyColorGrading(colorGrading)
        engine.destroyIndirectLight(indirectLight)
        engine.destroyRenderer(renderer)
        engine.destroyView(filamentView)
        engine.destroyScene(scene)
        engine.destroyCameraComponent(cameraEntity)
        EntityManager.get().destroy(cameraEntity)
        engine.destroy()
    }
}

/**
 * The coin's orientation as a column-major 4x4: tilted about X, then turned about Y.
 *
 * Internal so [SupporterCoinTest] can check it without a GPU. The order is the one
 * every shell uses — tilt first, so the spindle itself is tilted and the coin reads
 * as a disc even edge-on, rather than tilting the already-turned coin and wobbling.
 */
internal fun tiltedSpin(tilt: Float, turn: Float): FloatArray {
    val ca = cos(tilt)
    val sa = sin(tilt)
    val cb = cos(turn)
    val sb = sin(turn)
    return floatArrayOf(
        cb, sa * sb, -ca * sb, 0f,
        0f, ca, sa, 0f,
        sb, -sa * cb, ca * cb, 0f,
        0f, 0f, 0f, 1f,
    )
}

/// Loading Filament's native libraries is a process-wide, one-time cost, and it
/// must happen before any Filament class is touched — including [Engine.create].
/// Routing surface creation through here is what guarantees that ordering: you
/// cannot get a surface to render into without having loaded the engine first.
private object FilamentRuntime {
    init {
        Utils.init()
    }

    fun surface(context: Context): TextureView = TextureView(context)
}
