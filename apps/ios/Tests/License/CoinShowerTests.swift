import Foundation
import Testing

@testable import FutoNotesNative

/// The coin burst's physics.
///
/// Three claims are worth a test, and none of them can be read off a screenshot:
/// the burst is CONFINED to the plate, it HEAPS along the bottom, and it ENDS. A
/// canvas full of coins that quietly leaked past the plate's edge, or that never
/// stopped asking for frames, would look perfectly fine in a still.
///
/// The assertions are invariants, so they hold whatever the randomised throw.
/// Android asserts the same three in `CoinShowerTest`; desktop's copy is
/// asserted from the outside by `tests/license-card.spec.ts`, because its
/// simulation is a closure inside `startCoinShower` (drift concept
/// `supporter-coin-burst`).
@MainActor
@Suite("Coin burst")
struct CoinShowerTests {
    private let width: CGFloat = 360
    private let height: CGFloat = 420
    private let frame: Double = 1.0 / 60.0

    private func burst() -> CoinBurst {
        CoinBurst(
            size: CGSize(width: width, height: height), origin: CGPoint(x: width / 2, y: 100))
    }

    /// Runs the burst to its end, at most `frames` frames.
    private func run(_ burst: CoinBurst, frames: Int = 600) {
        var stepped = 0
        while !burst.finished && stepped < frames {
            burst.advance(frame)
            stepped += 1
        }
    }

    @Test("every coin stays inside the plate, on every frame")
    func coinsStayInside() {
        let burst = burst()
        var stepped = 0
        while !burst.finished && stepped < 600 {
            burst.advance(frame)
            stepped += 1
            for coin in burst.coins {
                #expect(coin.x - coin.radius >= -0.5, "left the left wall at frame \(stepped)")
                #expect(
                    coin.x + coin.radius <= width + 0.5, "left the right wall at frame \(stepped)")
                #expect(coin.y - coin.radius >= -0.5, "left the top at frame \(stepped)")
                #expect(
                    coin.y + coin.radius <= height + 0.5, "left the bottom at frame \(stepped)")
            }
        }
    }

    @Test("the burst heaps along the bottom of the plate")
    func burstHeaps() {
        let burst = burst()
        run(burst)

        #expect(burst.coins.count == coinBurstCount)
        // By the time it fades, the whole burst has come down: every coin is in
        // the bottom third, which is what makes it read as a heap rather than as
        // coins still flying when they vanish. Not every one is at REST — the
        // restitution is high on purpose and the last few are still bouncing
        // small — so the heap, not the rest flag, is the claim.
        #expect(burst.coins.allSatisfy { $0.y > height * 0.66 })
        let resting = burst.coins.filter(\.resting)
        #expect(resting.count > coinBurstCount / 2, "only \(resting.count) coins came to rest")
        // Scattered rest lines, so 120 coins read as a heap rather than as a
        // gold rule drawn along the bottom edge.
        #expect(Set(resting.map(\.y)).count > 1)
    }

    @Test("the burst fades out and finishes")
    func burstFinishes() {
        let burst = burst()

        #expect(burst.opacity == 1)
        run(burst)

        #expect(burst.finished)
        #expect(burst.opacity == 0, "a finished burst draws nothing")
    }

    /// The app never calls `advance(_:)` — it calls `advance(to:)`, and the
    /// first version of that path never moved a coin at all, because the frame
    /// delta it read was SwiftUI state written after the draw that consumed it.
    /// So the wall-clock entry point gets its own test.
    @Test("advancing by the clock moves the burst, and re-drawing the same frame does not")
    func advancingByTheClock() {
        let burst = burst()
        let start = Date()
        let origin = burst.coins.map(\.y)

        // The first frame establishes the clock and moves nothing.
        burst.advance(to: start)
        #expect(burst.coins.map(\.y) == origin)

        burst.advance(to: start.addingTimeInterval(1.0 / 60.0))
        #expect(burst.coins.map(\.y) != origin, "a frame of clock time moved nothing")

        // SwiftUI may ask a canvas to draw more than once for the same frame;
        // a second call at the same instant must be a no-op, not a double step.
        let afterOneFrame = burst.coins.map(\.y)
        burst.advance(to: start.addingTimeInterval(1.0 / 60.0))
        #expect(burst.coins.map(\.y) == afterOneFrame)
    }

    @Test("a huge frame delta cannot teleport a coin through a wall")
    func frameDeltaIsClamped() {
        // A view that was off screen hands back a huge first delta; unclamped,
        // one 300ms step would put a coin outside the plate and it would be
        // caught there and bounced every frame after.
        let burst = burst()
        burst.advance(0.3)

        for coin in burst.coins {
            #expect(coin.x - coin.radius >= -0.5)
            #expect(coin.x + coin.radius <= width + 0.5)
            #expect(coin.y + coin.radius <= height + 0.5)
        }
    }
}
