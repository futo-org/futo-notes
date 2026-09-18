import Foundation
import Testing
import simd

@testable import FutoNotesNative

/// The supporter coin's orientation law, and its tap queue.
///
/// The coin is a Blender model, so its shape and materials are not Swift's business
/// — `just coin-check` asserts those against the script that produced them. What
/// Swift still decides is how the model is turned, and there is exactly one way to
/// get that wrong that still looks plausible on a still screenshot: composing the
/// tilt and the spin in the other order.
///
/// Tilt-then-spin gives a coin on a FIXED tilted spindle, which is what a coin on a
/// stand does. Spin-then-tilt tilts the already-turned coin, so the spindle swings
/// as the coin goes round and it wobbles like a dropped hubcap. Both render; only
/// one is a coin.
///
/// Android asserts the same law over the same angles in `SupporterCoinTest`
/// (drift concept `supporter-coin-motion`). Quaternions and a column-major matrix
/// are different spellings of it, so these two suites are the only thing keeping
/// the two shells honest about the order.
///
/// The second half of the file is the TAP QUEUE, added 2026-09-18 with the coin's
/// tap: `CoinTapDebt` is the angle a tap owes, and the one way to get it wrong is
/// to drop taps.
@MainActor
@Suite("Supporter coin")
struct SupporterCoinTests {
    private let tilt: Float = 0.24

    /// Where the model's own axis ends up once the coin is turned.
    private func axis(_ modelAxis: SIMD3<Float>, turn: Float) -> SIMD3<Float> {
        CoinTurn.tiltedSpin(tilt: tilt, turn: turn).act(modelAxis)
    }

    @Test("the spindle does not move as the coin turns")
    func spindleIsFixed() {
        // The model's +Y is its spindle. Under tilt-then-spin it is the tilt's
        // axis alone, so every angle of turn must leave it in exactly one place.
        let atRest = axis([0, 1, 0], turn: 0)
        for turn: Float in [0.3, 1.1, 2.7, 4.4, 6.0] {
            let spindle = axis([0, 1, 0], turn: turn)
            #expect(abs(spindle.x - atRest.x) < 1e-5, "x moved at turn \(turn)")
            #expect(abs(spindle.y - atRest.y) < 1e-5, "y moved at turn \(turn)")
            #expect(abs(spindle.z - atRest.z) < 1e-5, "z moved at turn \(turn)")
        }
    }

    @Test("the spindle leans by exactly the tilt")
    func spindleLean() {
        let spindle = axis([0, 1, 0], turn: 1.9)
        #expect(abs(simd_dot(spindle, SIMD3<Float>(0, 1, 0)) - cos(tilt)) < 1e-5)
    }

    @Test("face-on at rest, edge-on a quarter turn later")
    func faceThenEdge() {
        // The model's +Z is its face normal, and the camera looks down -Z from +Z,
        // so a face-on coin has its normal pointing at the camera, leaning away
        // by the tilt and nothing more.
        let atRest = axis([0, 0, 1], turn: 0)
        #expect(abs(atRest.z - cos(tilt)) < 1e-5)

        let quarter = axis([0, 0, 1], turn: .pi / 2)
        #expect(abs(quarter.z) < 1e-5, "a quarter turn should be edge-on, got z=\(quarter.z)")
    }

    @Test("it is a rotation, not a skew")
    func staysOrthonormal() {
        let x = axis([1, 0, 0], turn: 2.2)
        let y = axis([0, 1, 0], turn: 2.2)
        let z = axis([0, 0, 1], turn: 2.2)
        for (name, vector) in [("x", x), ("y", y), ("z", z)] {
            #expect(abs(simd_length(vector) - 1) < 1e-5, "\(name) is not a unit vector")
        }
        #expect(abs(simd_dot(x, y)) < 1e-5)
        #expect(abs(simd_dot(y, z)) < 1e-5)
        #expect(abs(simd_dot(x, z)) < 1e-5)
        // Right-handed, or the coin renders inside out.
        #expect(simd_length(simd_cross(x, y) - z) < 1e-5)
    }

    // ── The tap queue ───────────────────────────────────────────────────────
    // What a tap adds is an ANGLE the coin owes, and `CoinTapDebt` is the whole
    // model: `tap()` ADDS a turn and `pay()` is the only way the debt ever
    // leaves. The version this replaced held a phase into a single timed turn
    // and put it back to zero on every tap — indistinguishable from this on one
    // tap, and it swallows nine taps out of ten on a burst.
    //
    // "ten taps turn the coin ten times" is therefore the case that matters, and
    // it is red-proved: with `tap()` changed to `outstanding = tapTurn` it
    // reports 6.28 radians turned against the 62.83 it expects.
    //
    // Android asserts the same model in `SupporterCoinTest`, desktop in
    // `supporterCoin.test.ts` (drift concept `supporter-coin-motion`).

    /// One tap's worth of turn.
    private var oneTurn: Float { .pi * 2 }
    /// A 60 Hz frame.
    private var frame: Float { 1.0 / 60.0 }

    /// Taps the coin, runs frames until it owes nothing, and reports how much
    /// turn was actually delivered and how long it took. `tapAfterFrames` queues
    /// another tap partway through, which is the case a debt handles and a
    /// restart cannot.
    private func turnsDelivered(taps: Int, tapAfterFrames: Set<Int> = []) -> (
        turned: Float, frames: Int
    ) {
        var debt = CoinTapDebt()
        for _ in 0..<taps { debt.tap() }
        var turned: Float = 0
        var frames = 0
        // A ceiling, so a payout that never terminates fails as a test rather
        // than hanging the suite.
        while debt.outstanding > 0 && frames < 6000 {
            if tapAfterFrames.contains(frames) { debt.tap() }
            turned += debt.pay(frame)
            frames += 1
        }
        #expect(debt.outstanding == 0, "the debt must reach zero")
        return (turned, frames)
    }

    @Test("one tap turns the coin exactly once, and finishes")
    func oneTapIsOneTurn() {
        let (turned, frames) = turnsDelivered(taps: 1)

        #expect(abs(turned - oneTurn) < 1e-3)
        // Just over a second: a flourish that coasts, not a wind-down.
        #expect(frames < 80, "took \(frames) frames")
    }

    @Test("ten taps turn the coin ten times")
    func tenTapsAreTenTurns() {
        let (turned, _) = turnsDelivered(taps: 10)

        #expect(abs(turned - oneTurn * 10) < 1e-2, "turned \(turned)")
    }

    @Test("a tap that lands while an earlier one is still being paid is kept")
    func aTapDuringAPayoutIsKept() {
        let (turned, _) = turnsDelivered(taps: 1, tapAfterFrames: [3])

        #expect(abs(turned - oneTurn * 2) < 1e-2, "turned \(turned)")
    }

    @Test("however much is owed, the payout never strobes")
    func payoutNeverStrobes() {
        // Fifty turns owed would open at 942 rad/s uncapped, which is fifteen
        // turns in a single 60 Hz frame: a coin that reads as stationary.
        #expect(tapTurnPayout(debt: oneTurn * 50, seconds: frame) < oneTurn / 2)
    }

    @Test("an untapped coin owes nothing and is paid nothing")
    func nothingOwedPaysNothing() {
        var debt = CoinTapDebt()

        #expect(debt.outstanding == 0)
        #expect(debt.pay(frame) == 0)
    }
}
