import CoreGraphics
import ImageIO
import RealityKit
import SwiftUI
import simd

/// The coin and the studio it reflects, both exported by assets/coin/build-coin.py
/// and bundled by apps/ios/project.yml.
private enum CoinAsset {
    static let model = (name: "futo-coin", extension: "usdz")
    static let environment = (name: "studio-env", extension: "hdr")
}

/// Slow enough to read as an object rather than a spinner: one turn every ~5s.
/// The same number desktop and Android use, in the same units.
private let baseSpin: Float = 1.25

/// How fast any departure from the resting speed — a flick — bleeds off.
private let spinDecay: Float = 2.6

/// Radians of turn per point dragged. Desktop's constant is per CSS pixel and a
/// point is the same apparent size, so the coin turns the same amount under the
/// same thumb travel on all three.
private let dragRadiansPerPoint: Float = 0.018

/// A flick is only a flick if the finger was still moving when it left. Below
/// this the coin is *placed*, and stays where it was put.
private let flickMinimumSpeed: Float = 0.6

/// Ceiling on a thrown spin, so a fast swipe cannot turn the coin into a strobe.
private let flickMaximumSpeed: Float = 24

/// A fixed tilt, so the coin reads as a disc even at the instant its face is
/// edge-on to the camera. Desktop and Android apply the same angle.
private let tiltX: Float = 0.24

/// The camera. A 30 degree field of view at this distance frames the model's 0.7
/// diameter at about 84% of the box, leaving room for the corners as it turns —
/// the same framing as the other two shells.
private let cameraFieldOfView: Float = 30
private let cameraDistance: Float = 1.55

/// Frame-time clamp. A view that was off screen hands back a huge delta on its
/// first frame; without this the coin jumps a random fraction of a turn.
private let maximumFrameSeconds: Float = 1 / 20

/**
 The FUTO supporter coin, turning on its spindle.

 This renders the SAME object desktop and Android render: `assets/coin/futo-coin.usdz`,
 exported from the Blender model in `assets/coin/build-coin.py`, lit by `studio-env.hdr`
 — the studio from the same script, which ImageIO happens to read natively
 (`public.radiance`), so iOS needs no converted copy of it. Nothing about the coin's
 shape or its materials is written in Swift; this file only frames it, turns it and
 hands it to RealityKit.

 That replaces a 2D projection which drew the flat glyph twice to fake an extruded
 disc. The projection was clever and cost nothing, but it could not light metal: gold
 is defined by what it reflects, and a shape with a gradient painted on it reads as a
 sticker however correctly it is squeezed.

 Drag it and it turns under your thumb; let go while moving and it spins on. It holds
 still — as a whole, correct coin, not a placeholder — under Reduce Motion, which is
 the same answer desktop gives `prefers-reduced-motion`.
 */
struct SupporterCoin: View {
    let diameter: CGFloat

    /// Motion is opt-out at the OS level, so ask before spinning anything.
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    @State private var turn = CoinTurn()
    @State private var loadFailed = false
    /// Cumulative drag translation at the last change, so each event contributes
    /// the distance the thumb moved rather than the distance it has moved in total.
    @State private var lastDragX: CGFloat = 0

    var body: some View {
        Group {
            if loadFailed {
                // A whole coin, just a still one. Reached only if the bundled
                // model or environment will not load, which is also the only
                // state the old projection-based coin could ever be in.
                Image(decorative: "SupporterCoin")
                    .resizable()
                    .scaledToFit()
            } else {
                RealityView { content in
                    await build(content)
                }
            }
        }
        .frame(width: diameter, height: diameter)
        .accessibilityHidden(true)
        .gesture(
            DragGesture(minimumDistance: 1)
                .onChanged { value in
                    if !turn.dragging {
                        turn.grab()
                        lastDragX = value.translation.width
                    }
                    let delta = Float(value.translation.width - lastDragX)
                    lastDragX = value.translation.width
                    turn.turnBy(delta * dragRadiansPerPoint)
                }
                .onEnded { value in
                    // `velocity` is points/second; the same constant that turns a
                    // drag into radians turns it into radians/second.
                    let thrown = Float(value.velocity.width) * dragRadiansPerPoint
                    turn.release(
                        abs(thrown) > flickMinimumSpeed
                            ? min(max(thrown, -flickMaximumSpeed), flickMaximumSpeed)
                            : nil
                    )
                    lastDragX = 0
                }
        )
        .onChange(of: reduceMotion, initial: true) { _, paused in
            turn.animates = !paused
        }
    }

    @MainActor
    private func build(_ content: RealityViewContent) async {
        guard
            let modelURL = Bundle.main.url(
                forResource: CoinAsset.model.name, withExtension: CoinAsset.model.extension),
            let coin = try? await Entity(contentsOf: modelURL)
        else {
            loadFailed = true
            return
        }

        // The coin is turned through a PIVOT rather than directly. The exported
        // model carries its own transform (it is authored lying down and stood up
        // on export), so turning it directly would tumble it end over end instead
        // of spinning it on its spindle.
        let pivot = Entity()
        pivot.addChild(coin)
        content.add(pivot)
        turn.attach(to: pivot)

        if let environment = await Self.studioEnvironment() {
            // An image-based light rather than a skybox: a skybox would paint the
            // studio behind the coin, and the coin has to sit on the app's card.
            // The environment IS the lighting — no directional or ambient light is
            // added, so every highlight is a reflection of studio-env.hdr, which is
            // what makes this render and the other two the same object.
            let light = Entity()
            light.components.set(
                ImageBasedLightComponent(source: .single(environment), intensityExponent: 0))
            content.add(light)
            pivot.components.set(ImageBasedLightReceiverComponent(imageBasedLight: light))
        }

        let camera = PerspectiveCamera()
        camera.camera.fieldOfViewInDegrees = cameraFieldOfView
        camera.camera.near = 0.1
        camera.camera.far = 10
        camera.look(at: .zero, from: [0, 0, cameraDistance], relativeTo: nil)
        content.add(camera)

        // RealityKit's own update event rather than a SwiftUI timeline: it carries
        // the real frame delta and fires on the render loop, so the coin cannot
        // desynchronise from the frames it is being drawn into.
        turn.subscription = content.subscribe(to: SceneEvents.Update.self) { event in
            turn.step(Float(event.deltaTime))
        }
    }

    /// The studio, decoded straight from the Radiance .hdr the other two shells use.
    ///
    /// ImageIO lists `public.radiance` among its readable types, so the file that
    /// lights the coin on desktop lights it here too — no converted copy, and no
    /// second thing to keep in step with the Blender script.
    private static func studioEnvironment() async -> EnvironmentResource? {
        guard
            let url = Bundle.main.url(
                forResource: CoinAsset.environment.name,
                withExtension: CoinAsset.environment.extension),
            let source = CGImageSourceCreateWithURL(url as CFURL, nil),
            let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
        else { return nil }
        return try? await EnvironmentResource(equirectangular: image)
    }
}

/// Where the coin is pointed, and how that changes over time.
///
/// Separate from the view because the angle advances on RealityKit's render loop
/// rather than on SwiftUI state changes: rebuilding the view sixty times a second
/// to turn a coin would be its own bug.
@MainActor
@Observable
final class CoinTurn {
    var animates = true
    private(set) var dragging = false
    /// Retained because an `EventSubscription` stops delivering the moment it is
    /// released, which would leave a coin that renders but never moves.
    var subscription: EventSubscription?

    private var pivot: Entity?
    private var angle: Float = 0
    private var spin: Float = baseSpin

    func attach(to entity: Entity) {
        pivot = entity
        apply()
    }

    func grab() {
        dragging = true
    }

    func turnBy(_ radians: Float) {
        angle += radians
        apply()
    }

    /// `thrown` is nil when the finger was resting as it lifted: the coin was
    /// placed, and eases back to its resting speed from wherever it was put.
    func release(_ thrown: Float?) {
        dragging = false
        spin = thrown ?? restingSpin
    }

    func step(_ elapsed: Float) {
        // While a finger is down the gesture owns the angle outright: the coin
        // tracks the hand exactly rather than being nudged by a velocity, which is
        // what makes it feel like an object and not a dial.
        guard !dragging else { return }
        let delta = min(elapsed, maximumFrameSeconds)
        // Eases in from either side, so a backwards flick settles as gracefully as
        // a forwards one.
        spin = restingSpin + (spin - restingSpin) * exp(-spinDecay * delta)
        angle += spin * delta
        apply()
    }

    private var restingSpin: Float { animates ? baseSpin : 0 }

    private func apply() {
        pivot?.transform.rotation = Self.tiltedSpin(tilt: tiltX, turn: angle)
    }

    /// The coin's orientation: tilted about X, then turned about Y.
    ///
    /// The order is the one every shell uses. Tilt first gives a coin on a FIXED
    /// tilted spindle, which is what a coin on a stand does; spinning first and
    /// tilting after swings the spindle itself and the coin wobbles like a dropped
    /// hubcap. Quaternion multiplication applies the RIGHT operand first, so this
    /// reads backwards from the order it performs.
    static func tiltedSpin(tilt: Float, turn: Float) -> simd_quatf {
        simd_quatf(angle: tilt, axis: [1, 0, 0]) * simd_quatf(angle: turn, axis: [0, 1, 0])
    }
}
