import SwiftUI

// A hundred-odd little coins, bouncing around inside the License plate.
//
// FUTOpay's checkout page does this on a purchase (`coin-bounce.js` in
// lib-polar), @justin asked for the same moment in the app, and desktop shipped
// it 2026-09-18. This is that, in Swift — the same numbers and the same model:
//
//   - **Confined.** The canvas is the plate's own overlay and the coins bounce
//     off its four walls, so the celebration belongs to the thing being
//     celebrated rather than raining over the note list behind Settings.
//   - **No physics engine.** Ballistic motion plus a coefficient of restitution
//     is the whole model. Rigid-body contact resolution buys nothing anything
//     can see at eight points across.
//   - **No second 3D scene.** The coin in the well is already a RealityKit
//     scene; this is a 2D `Canvas`, which costs none.
//
// It runs for a few seconds in Settings — a surface the user opened on purpose
// — and takes itself down afterwards (M5: nothing animates in the background).
//
// One concept, three shells (drift registry `supporter-coin-burst`):
// `src/features/license/coinShower.ts` and
// `apps/android/.../ui/CoinShower.kt` are the other two, and the constants
// below are theirs.

/// How many coins the burst throws. The FUTOpay page spawns one per click and
/// lets them pile up; this is the whole pile at once.
let coinBurstCount = 120

/// Points per second squared. Tuned against the plate's height rather than a
/// real g: what matters is that a coin thrown at the top of the plate comes back
/// down within about a second.
private let coinBurstGravity: CGFloat = 1500

/// Opening speed, in points per second. The spread is wide on purpose — a
/// uniform burst reads as a mechanism, an uneven one as a handful of coins.
private let coinBurstSpeedMin: CGFloat = 260
private let coinBurstSpeedMax: CGFloat = 760

/// How much speed survives a bounce. High on purpose: the plate is only a few
/// hundred points tall, so a realistic 0.4 has every coin parked in under a
/// second and the whole thing reads as a pile rather than as coins bouncing.
private let coinBurstWallRestitution: CGFloat = 0.62
private let coinBurstFloorRestitution: CGFloat = 0.66
/// Horizontal speed lost on each floor contact, so coins drift rather than
/// skating the full width forever.
private let coinBurstFloorFriction: CGFloat = 0.9
/// Below this vertical speed a coin touching its rest line is laid down rather
/// than bounced again — otherwise it buzzes at sub-point amplitudes forever.
private let coinBurstRestSpeed: CGFloat = 55
/// How far above the floor a coin may come to rest. Nothing here collides with
/// anything else, so without this every coin parks on the same line and 120 of
/// them read as a gold rule drawn along the bottom edge.
private let coinBurstRestScatter: CGFloat = 26

/// Radians per second of tumble. A coin is drawn edge-on as it passes through a
/// quarter turn, which is the whole reason it reads as a coin and not a dot.
private let coinBurstTumbleMin: CGFloat = 6
private let coinBurstTumbleMax: CGFloat = 22

private let coinBurstRadiusMin: CGFloat = 5
private let coinBurstRadiusMax: CGFloat = 9

/// How long the coins stay before they start to go, and how long they take.
/// Short enough that most are still in the air when the fade starts — a burst
/// that outlives its own motion is just clutter on the plate.
let coinBurstSettleSeconds: Double = 2.3
let coinBurstFadeSeconds: Double = 0.9

/// Frame-time clamp, the same reason the coin itself has one: a view that was
/// off screen hands back a huge first delta, and a 300ms step would teleport
/// every coin through a wall.
private let coinBurstMaxFrameSeconds: CGFloat = 1.0 / 30.0

/// Gold, matching the coin in the well and the plate's accent.
private let coinBurstFaceLight = Color(hex: 0xFFD2_4D)
private let coinBurstFaceDark = Color(hex: 0xC892_0C)
private let coinBurstRim = Color(hex: 0x8B65_08)
/// The FUTO diamond, as a fraction of the radius — the same 0.45 the Blender
/// model and all three flat glyphs use.
private let coinBurstDiamondHalf: CGFloat = 0.45

/// One tumbling coin.
struct BurstCoin {
    var x: CGFloat
    var y: CGFloat
    var velocityX: CGFloat
    var velocityY: CGFloat
    var radius: CGFloat
    /// Where the coin is in its tumble. `cos(phase)` is how much of its face is
    /// turned toward us, so 0 is face-on and a quarter turn is edge-on.
    var phase: CGFloat
    var tumble: CGFloat
    /// The tilt of the spin axis in the plane, so they do not all tumble about
    /// the same horizontal line.
    var tilt: CGFloat
    /// The y this coin settles on, scattered so the heap has depth.
    var restOffset: CGFloat
    var resting: Bool
}

/// The burst's whole state: where every coin is and how long it has been going.
///
/// A class rather than a struct because a `Canvas` steps it from inside its own
/// draw closure — there is no SwiftUI state to invalidate per frame, only
/// pixels. Its arithmetic is pure, which is what `CoinShowerTests` drives.
@MainActor
final class CoinBurst {
    private(set) var coins: [BurstCoin]
    private(set) var elapsed: Double = 0
    private let size: CGSize
    /// When the last frame was drawn. The burst owns its own clock rather than
    /// reading one out of SwiftUI state: a `@State` delta updated from
    /// `onChange` is ordered against the draw that consumes it, and the order
    /// SwiftUI actually chose left every coin sitting on its spawn point,
    /// unmoved and unfaded, four seconds after the burst was thrown.
    private var lastFrame: Date?

    /// Everything is thrown UPWARD out of `origin`: coins that started downward
    /// simply bounced once and looked like they had been dropped.
    init(size: CGSize, origin: CGPoint, count: Int = coinBurstCount) {
        self.size = size
        self.coins = (0..<count).map { _ in
            let angle = CGFloat.random(in: (.pi * 1.15)...(.pi * 1.85))
            let speed = CGFloat.random(in: coinBurstSpeedMin...coinBurstSpeedMax)
            return BurstCoin(
                x: origin.x + .random(in: -12...12),
                y: origin.y + .random(in: -12...12),
                velocityX: cos(angle) * speed,
                velocityY: sin(angle) * speed,
                radius: .random(in: coinBurstRadiusMin...coinBurstRadiusMax),
                phase: .random(in: 0...(.pi * 2)),
                tumble: .random(in: coinBurstTumbleMin...coinBurstTumbleMax)
                    * (Bool.random() ? 1 : -1),
                tilt: .random(in: -0.5...0.5),
                restOffset: .random(in: 0...coinBurstRestScatter),
                resting: false)
        }
    }

    /// True once every coin has faded out and there is nothing left to draw.
    var finished: Bool { elapsed >= coinBurstSettleSeconds + coinBurstFadeSeconds }

    /// How opaque the whole burst is: solid until it settles, then fading.
    var opacity: Double {
        elapsed <= coinBurstSettleSeconds
            ? 1
            : max(0, 1 - (elapsed - coinBurstSettleSeconds) / coinBurstFadeSeconds)
    }

    /// Advances to a wall-clock instant. Idempotent within a frame: a second
    /// call at the same date advances by nothing, so it does not matter how
    /// many times SwiftUI asks the canvas to draw.
    func advance(to now: Date) {
        let delta = lastFrame.map { now.timeIntervalSince($0) } ?? 0
        lastFrame = now
        advance(max(0, delta))
    }

    func advance(_ seconds: Double) {
        let step = CGFloat(min(seconds, Double(coinBurstMaxFrameSeconds)))
        elapsed += Double(step)
        for index in coins.indices {
            advance(&coins[index], step)
        }
    }

    private func advance(_ coin: inout BurstCoin, _ seconds: CGFloat) {
        if !coin.resting {
            coin.velocityY += coinBurstGravity * seconds
            coin.x += coin.velocityX * seconds
            coin.y += coin.velocityY * seconds
            coin.phase += coin.tumble * seconds
        }

        // Walls. Position is corrected as well as velocity, so a coin that
        // overshot in one step cannot be caught outside and bounced every frame.
        if coin.x - coin.radius < 0 {
            coin.x = coin.radius
            coin.velocityX = abs(coin.velocityX) * coinBurstWallRestitution
        } else if coin.x + coin.radius > size.width {
            coin.x = size.width - coin.radius
            coin.velocityX = -abs(coin.velocityX) * coinBurstWallRestitution
        }
        if coin.y - coin.radius < 0 {
            coin.y = coin.radius
            coin.velocityY = abs(coin.velocityY) * coinBurstWallRestitution
        }

        let floor = size.height - coin.radius - coin.restOffset
        if coin.y >= floor {
            coin.y = floor
            if abs(coin.velocityY) < coinBurstRestSpeed {
                // Laid flat, face up, and left alone.
                coin.resting = true
                coin.velocityX = 0
                coin.velocityY = 0
                coin.phase = 0
            } else {
                coin.velocityY = -abs(coin.velocityY) * coinBurstFloorRestitution
                coin.velocityX *= coinBurstFloorFriction
                coin.tumble *= coinBurstFloorFriction
            }
        }
    }
}

/// The burst, drawn on the plate.
///
/// Sized and positioned by the caller: it fills whatever box it is given and
/// bounces its coins off that box's walls, so "inside the plate" is structural
/// rather than something a screenshot has to judge.
struct CoinShower: View {
    /// How far down the plate the coins come from. Horizontally they start at
    /// the middle, which is where the well — and therefore the coin that was
    /// just earned — sits on both native shells.
    let originY: CGFloat
    /// Called once the last coin has faded, so the plate can drop this view.
    let onFinished: () -> Void

    var body: some View {
        GeometryReader { proxy in
            CoinShowerCanvas(
                size: proxy.size,
                origin: CGPoint(x: proxy.size.width / 2, y: min(originY, proxy.size.height)),
                onFinished: onFinished)
        }
        // The burst covers the plate and must never eat a tap meant for the Buy
        // button or the coin underneath it.
        .allowsHitTesting(false)
    }
}

/// The canvas itself, once the box it fills is known.
private struct CoinShowerCanvas: View {
    let size: CGSize
    let origin: CGPoint
    let onFinished: () -> Void

    @State private var burst: CoinBurst

    init(size: CGSize, origin: CGPoint, onFinished: @escaping () -> Void) {
        self.size = size
        self.origin = origin
        self.onFinished = onFinished
        _burst = State(initialValue: CoinBurst(size: size, origin: origin))
    }

    var body: some View {
        TimelineView(.animation) { timeline in
            Canvas { context, _ in
                // Stepped from inside the draw, because the per-frame state is
                // pixels and not SwiftUI state: invalidating a view 60 times a
                // second to move 120 dots would be its own bug. The burst reads
                // the clock itself, so nothing here depends on a `@State` write
                // landing before the draw that consumes it.
                burst.advance(to: timeline.date)
                context.opacity = burst.opacity
                for coin in burst.coins { paint(coin, into: context) }
            }
            .onChange(of: timeline.date) { _, _ in
                if burst.finished { onFinished() }
            }
        }
    }

    /// `cos(phase)` is how much of the face is turned toward us. Squashing the
    /// disc by it is the whole tumble: at a quarter turn the coin is a line, and
    /// what is left is its rim.
    private func paint(_ coin: BurstCoin, into context: GraphicsContext) {
        let facing = abs(cos(coin.phase))
        var context = context
        context.translateBy(x: coin.x, y: coin.y)
        context.rotate(by: .radians(Double(coin.tilt)))

        // The rim, drawn first and slightly proud of the face, so an edge-on
        // coin is a bright gold sliver rather than nothing at all.
        context.fill(
            Path(
                ellipseIn: CGRect(
                    x: -coin.radius, y: -max(coin.radius * facing, 0.6),
                    width: coin.radius * 2, height: max(coin.radius * facing, 0.6) * 2)),
            with: .color(coinBurstRim))

        guard facing > 0.12 else { return }
        let faceWidth = coin.radius * 0.88
        let faceHeight = coin.radius * facing * 0.88
        context.fill(
            Path(
                ellipseIn: CGRect(
                    x: -faceWidth, y: -faceHeight, width: faceWidth * 2, height: faceHeight * 2)),
            with: .linearGradient(
                Gradient(colors: [coinBurstFaceLight, coinBurstFaceDark]),
                startPoint: CGPoint(x: -coin.radius, y: -coin.radius),
                endPoint: CGPoint(x: coin.radius, y: coin.radius)))

        // The FUTO diamond. Shaded rather than punched: a real hole would have
        // to show whatever is behind this coin, and at eight points across a
        // dark recess reads the same and costs one path.
        let half = coin.radius * coinBurstDiamondHalf
        var diamond = Path()
        diamond.move(to: CGPoint(x: 0, y: -half * facing))
        diamond.addLine(to: CGPoint(x: half, y: 0))
        diamond.addLine(to: CGPoint(x: 0, y: half * facing))
        diamond.addLine(to: CGPoint(x: -half, y: 0))
        diamond.closeSubpath()
        context.fill(diamond, with: .color(coinBurstRim))
    }
}
