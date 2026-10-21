package com.futo.notes.ui

import android.content.Context
import android.provider.Settings
import android.view.Choreographer
import android.view.TextureView
import androidx.compose.foundation.layout.size
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
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.sin

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
/// Desktop is the reference (@justin 2026-09-18): this is whatever value makes
/// Android's coin read like the three.js one, and it is MEASURED, never reasoned
/// about. The previous value, 4.5, was reasoned about — its comment said cmgen
/// had "already normalized" the cubemap, so Filament's lux-denominated intensity
/// needed scaling back up. That premise is false. studio-env-ibl.ktx is
/// R11F_G11F_B10F carrying absolute radiance: its mean is 3.41 against the
/// source .hdr's 3.15 and its peak is 47.0 against 46.75, so cmgen normalized
/// nothing, and 4.5 was multiplying light that was already at full strength.
/// On a phone the coin spent most of its rotation paler than desktop's — worst
/// angle 20% saturation against desktop's 44%.
///
/// How to redo this if the studio changes: capture ~22 frames of each renderer
/// at random points in the rotation, mask off the antialiased rim, and compare
/// the rotational MEAN of brightness and saturation. `just coin-tuner`'s exposure
/// slider is the desktop half of that comparison and reaches 6 for this reason.
///
/// Measured that way, 4.5 was the desktop renderer at ~1.95x exposure and 1.75
/// matched desktop's saturation exactly (69.3 against 67.7) while landing 9
/// points under on brightness. On a screen beside the desktop app it still read
/// bright (@justin), so this sits a further step down. The eye wins: the capture
/// path goes through screencap and a color key, a side-by-side comparison on one
/// display does not.
///
/// 1.25 was accepted on a REAL DEVICE, which is the bar that matters: a Moto G
/// Play 2023 (32-bit ARM, PowerVR Rogue GE8320, Filament clamped to feature
/// level 1) renders the coin visibly deeper than the x86 emulator does at the
/// same value -- 71.9 brightness / 73.3 saturation against the emulator's 74.2 /
/// 71.4. Judge this constant on hardware, not on an emulator.
private const val IBL_INTENSITY = 1.25f
private const val CAMERA_EXPOSURE = 1.0f

/**
 * One coin: a Filament engine, the loaded model, the environment that lights it,
 * and the frame loop that turns it.
 *
 * Everything here is native memory. Filament tracks none of it for you, and a
 * Settings sheet that is opened and closed all day would leak an engine per visit,
 * so [destroy] frees it in the order Filament requires — the asset before the
 * loader that made it, the swap chain before the engine.
 */
internal class CoinScene(
    private val context: Context,
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
    // first Android render came out looking like brushed aluminum. Desktop's
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
    /// The angle the coin owes its taps: added to on every tap, paid down every
    /// frame, and never reset.
    private val tapDebt = CoinTapDebt()
    private var lastFrameNanos = 0L
    private var destroyed = false
    /// Whether a frame has come back from Filament at all — see the render loop.
    private var rendered = false

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
                // The taps' turn is ADDED to the ambient one rather than
                // replacing it, which is what lets a queue exist at all: there
                // is no single turn with a start to reset, only an angle still
                // owed.
                turn += spin * elapsed + tapDebt.pay(elapsed)
                applyTurn()
            }

            val chain = swapChain
            if (chain != null && uiHelper.isReadyToRender) {
                if (renderer.beginFrame(chain, frameTimeNanos)) {
                    renderer.render(filamentView)
                    renderer.endFrame()
                    // The abort a bad driver dies on happens INSIDE that call,
                    // while Filament compiles its post-process materials. Being
                    // here means it did not, so the attempt this scene recorded
                    // on the way in can be cleared ([FilamentSupport]).
                    if (!rendered) {
                        rendered = true
                        FilamentSupport.renderSucceeded(context)
                    }
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
                // A box that is not square keeps the coin round and centered
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

    /// A tap adds a turn to what the coin owes. An impatient second tap is a
    /// second turn, and the tenth is the tenth.
    fun tap() = tapDebt.tap()

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
internal object FilamentRuntime {
    init {
        Utils.init()
    }

    fun surface(context: Context): TextureView = TextureView(context)
}
