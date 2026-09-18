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

/// A tap on the coin owes it one more full turn (@justin 2026-09-17).
///
/// Taps QUEUE, because what a tap adds is an ANGLE and not a restart: ten fast
/// taps are ten turns (@justin 2026-09-18). The obvious implementation — hold a
/// phase into a single timed turn and set it back to zero on every tap — is the
/// bug this replaced; it looks perfectly correct on one tap and swallows every
/// tap but the last on ten.
private let tapTurn: Float = .pi * 2
/// How fast the debt is paid: radians per second for each radian still owed.
/// One turn owed opens at ~19 rad/s and is nine tenths paid in three quarters
/// of a second.
private let tapPayout: Float = 3
/// Ceiling on the payout rate. Ten queued turns owe 63 radians, which without
/// this would open at 188 rad/s: three turns in a single frame, i.e. a coin
/// that looks stationary or strobing.
private let tapMaximumRate: Float = 26
/// Floor on the payout rate, so the tail is a coast rather than an asymptote. A
/// purely proportional payout spends its last second turning the coin by
/// fractions of a degree.
private let tapMinimumRate: Float = 2
/// Below this the rest of the debt is handed over in one frame: half a degree
/// is not a turn, and the debt has to actually reach zero.
private let tapSettle: Float = 0.01
/// A press is a tap and not a drag if the thumb barely moved and did not
/// linger. Both bounds matter: a 2pt wobble is still a tap, and a slow,
/// deliberate 2pt nudge held for a second is not.
private let tapMaximumMovement: CGFloat = 5
private let tapMaximumMilliseconds: Double = 400

/// A fixed tilt, so the coin reads as a disc even at the instant its face is
/// edge-on to the camera. Desktop and Android apply the same angle.
private let tiltX: Float = 0.24

/// How much of an owed turn one frame pays off: fastest when the most is owed,
/// capped so a burst of taps cannot become a strobe, and handing over the last
/// sliver whole so the debt actually reaches zero.
///
/// Internal for its test. Everything the queue promises — that ten taps turn the
/// coin ten times, not once — is this function summing to exactly the debt it
/// was given. Desktop's `tapTurnPayout` is the same arithmetic in TypeScript
/// (drift concept `supporter-coin-motion`), and Android's is the same in Kotlin.
func tapTurnPayout(debt: Float, seconds: Float) -> Float {
    guard debt > 0 else { return 0 }
    let rate = min(max(debt * tapPayout, tapMinimumRate), tapMaximumRate)
    let paid = rate * seconds
    return debt - paid <= tapSettle ? debt : paid
}

/// The angle the coin owes its taps.
///
/// This small value type is the whole difference between "ten taps are ten
/// turns" and the bug it replaced. [tap] ADDS a turn; it does not set one. The
/// version this replaced held a phase into a single timed turn and put it back
/// to zero on every tap, which is indistinguishable from this on one tap and
/// swallows nine taps out of ten on a burst.
///
/// Separate from `CoinTurn` because the scene needs RealityKit and this does
/// not: `SupporterCoinTests` drives the queue frame by frame. Android keeps the
/// same object as `CoinTapDebt` in `SupporterCoin.kt`.
struct CoinTapDebt {
    /// Radians still owed. Readable so a test can watch the debt reach zero.
    private(set) var outstanding: Float = 0

    /// One more full turn, on top of whatever is already owed.
    mutating func tap() {
        outstanding += tapTurn
    }

    /// Pays down the debt and answers how much turn that buys this frame. The
    /// only way the debt ever leaves, which is what makes "no tap is dropped" a
    /// property of the code rather than a hope.
    mutating func pay(_ seconds: Float) -> Float {
        let paid = tapTurnPayout(debt: outstanding, seconds: seconds)
        outstanding -= paid
        return paid
    }
}

/// The camera. A 30 degree field of view at this distance frames the model's 0.7
/// diameter at about 84% of the box, leaving room for the corners as it turns —
/// the same framing as the other two shells.
private let cameraFieldOfView: Float = 30
private let cameraDistance: Float = 1.55

/// How hard the studio lights the coin, as a power of two (so -0.75 is about
/// three fifths of the environment's own values).
///
/// It is not 0, and the reason is the same one Android's IBL_INTENSITY is not 1:
/// each renderer scales an image-based light differently, so the same studio,
/// honestly converted, arrives at a different brightness in each. At 0 the coin
/// came out a pale yellow-white — the gold's hue washed out, red and green only
/// 37 apart where desktop holds them 58 apart.
///
/// Desktop is the reference (@justin 2026-09-18), and this was measured against
/// it rather than reasoned about. Method: capture 22 frames of each renderer at
/// random points in the coin's rotation, mask off the antialiased rim, and take
/// the rotational MEAN of brightness and of saturation — random phase makes the
/// mean unbiased, where a 22-frame median is noisy enough to be non-monotonic in
/// exposure. The previous -1.5 measured at 76.1 brightness / 86.1 saturation,
/// which is the desktop renderer at roughly 0.5-0.65x exposure: a little dim and
/// noticeably more saturated than desktop's 83.2 / 67.7. -0.75 is the midpoint
/// of that bracket, +0.75 of a stop.
///
/// UNVERIFIED ON DEVICE: the arithmetic is from a real measurement of the -1.5
/// build, but nothing has yet rendered -0.75. `just coin-tuner`'s exposure slider
/// is the desktop half of the comparison if it wants redoing.
private let coinLightExponent: Float = -0.75

/// Frame-time clamp. A view that was off screen hands back a huge delta on its
/// first frame; without this the coin jumps a random fraction of a turn.
private let maximumFrameSeconds: Float = 1 / 20

/// The FUTO supporter coin, turning on its spindle.
///
/// This renders the SAME object desktop and Android render: `assets/coin/futo-coin.usdz`,
/// exported from the Blender model in `assets/coin/build-coin.py`, lit by `studio-env.hdr`
/// — the studio from the same script, which ImageIO happens to read natively
/// (`public.radiance`), so iOS needs no converted copy of it. Nothing about the coin's
/// shape or its materials is written in Swift; this file only frames it, turns it and
/// hands it to RealityKit.
///
/// That replaces a 2D projection which drew the flat glyph twice to fake an extruded
/// disc. The projection was clever and cost nothing, but it could not light metal: gold
/// is defined by what it reflects, and a shape with a gradient painted on it reads as a
/// sticker however correctly it is squeezed.
///
/// Drag it and it turns under your thumb; let go while moving and it spins on. Tap it and
/// it turns once around, fast, on top of whatever it was already doing — and taps QUEUE,
/// so ten taps are ten turns. It holds still — as a whole, correct coin, not a
/// placeholder — under Reduce Motion, which is the same answer desktop gives
/// `prefers-reduced-motion`.
struct SupporterCoin: View {
    let diameter: CGFloat

    /// Motion is opt-out at the OS level, so ask before spinning anything.
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    @State private var turn = CoinTurn()
    @State private var loadFailed = false
    /// Cumulative drag translation at the last change, so each event contributes
    /// the distance the thumb moved rather than the distance it has moved in total.
    @State private var lastDragX: CGFloat = 0
    /// Total distance travelled and when the press began — together they
    /// separate a tap from a drag that happened to end where it started.
    @State private var travelled: CGFloat = 0
    @State private var pressedAt: Date?

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
                    await build(&content)
                }
            }
        }
        .frame(width: diameter, height: diameter)
        .accessibilityHidden(true)
        // `minimumDistance: 0` so a press that never moves still arrives: a tap
        // IS a drag that went nowhere, which is how desktop reads a click, and
        // recognising it any other way would have been a second definition of
        // the same gesture.
        .gesture(
            DragGesture(minimumDistance: 0)
                .onChanged { value in
                    if !turn.dragging {
                        turn.grab()
                        lastDragX = value.translation.width
                        travelled = 0
                        pressedAt = Date()
                    }
                    let delta = value.translation.width - lastDragX
                    lastDragX = value.translation.width
                    travelled += abs(delta)
                    turn.turnBy(Float(delta) * dragRadiansPerPoint)
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
                    // After `release`, so the turn starts from a coin that is
                    // already back under its own control.
                    let held = pressedAt.map { Date().timeIntervalSince($0) * 1000 } ?? .infinity
                    if travelled <= tapMaximumMovement, held <= tapMaximumMilliseconds {
                        turn.tap()
                    }
                    lastDragX = 0
                    travelled = 0
                    pressedAt = nil
                }
        )
        .onChange(of: reduceMotion, initial: true) { _, paused in
            turn.animates = !paused
        }
    }

    @MainActor
    private func build(_ content: inout RealityViewCameraContent) async {
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
                ImageBasedLightComponent(
                    source: .single(environment), intensityExponent: coinLightExponent))
            content.add(light)
            pivot.components.set(ImageBasedLightReceiverComponent(imageBasedLight: light))
        }

        // `.virtual` is what lets the PerspectiveCamera below be the camera. The
        // default on iOS frames the content itself, which would re-frame the coin
        // every time its silhouette narrowed — it would appear to breathe as it
        // turned rather than turn in place.
        content.camera = .virtual

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
    /// The angle the coin owes its taps: added to on every tap, paid down every
    /// frame, and never reset.
    private var tapDebt = CoinTapDebt()

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

    /// A tap adds a turn to what the coin owes. An impatient second tap is a
    /// second turn, and the tenth is the tenth.
    func tap() {
        tapDebt.tap()
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
        // The taps' turn is ADDED to the ambient one rather than replacing it,
        // which is what lets a queue exist at all: there is no single turn with
        // a start to reset, only an angle still owed.
        angle += spin * delta + tapDebt.pay(delta)
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
