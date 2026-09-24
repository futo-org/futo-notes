package com.futo.notes.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The supporter coin's orientation law.
 *
 * The coin is a Blender model now, so its shape and its materials are not this
 * file's business — they are asserted by `just coin-check` against the script that
 * produced them. What Kotlin still decides is how the model is turned, and there
 * is exactly one way to get that wrong that still looks plausible on a still
 * screenshot: composing the tilt and the spin in the other order.
 *
 * Tilt-then-spin gives a coin on a FIXED tilted spindle, which is what a coin on a
 * stand does. Spin-then-tilt tilts the already-turned coin, so the spindle itself
 * swings as the coin goes round and the coin wobbles like a dropped hubcap. Both
 * render; only one is a coin. The spindle test below is what separates them.
 *
 * The second half of the file is the TAP QUEUE, added 2026-09-18 with the coin's
 * tap: `tapTurnPayout` is pure arithmetic over the angle a tap owes, and the one
 * way to get it wrong is to drop taps.
 */
class SupporterCoinTest {
    private val tilt = 0.24f

    /** Column `index` of the column-major 4x4 as an (x, y, z) triple. */
    private fun column(matrix: FloatArray, index: Int) =
        Triple(matrix[index * 4], matrix[index * 4 + 1], matrix[index * 4 + 2])

    @Test
    fun `the spindle does not move as the coin turns`() {
        // The model's +Y is its spindle. Under tilt-then-spin it is the tilt's
        // axis alone, so every angle of turn must leave it in exactly one place.
        val atRest = column(tiltedSpin(tilt, 0f), 1)
        for (turn in listOf(0.3f, 1.1f, 2.7f, 4.4f, 6.0f)) {
            val spindle = column(tiltedSpin(tilt, turn), 1)
            assertEquals("x at turn=$turn", atRest.first, spindle.first, 1e-5f)
            assertEquals("y at turn=$turn", atRest.second, spindle.second, 1e-5f)
            assertEquals("z at turn=$turn", atRest.third, spindle.third, 1e-5f)
        }
    }

    // ── The tap queue ───────────────────────────────────────────────────────
    // What a tap adds is an ANGLE the coin owes, and [CoinTapDebt] is the whole
    // model: `tap()` ADDS a turn and `pay()` is the only way the debt ever
    // leaves. The version this replaced held a phase into a single timed turn
    // and put it back to zero on every tap — indistinguishable from this on one
    // tap, and it swallows nine taps out of ten on a burst.
    //
    // `ten taps turn the coin ten times` is therefore the case that matters, and
    // it is red-proved: with `tap()` changed to `outstanding = TAP_TURN` it
    // reports 6.28 radians turned against the 62.83 it expects.
    //
    // iOS asserts the same model in `SupporterCoinTests`, desktop in
    // `supporterCoin.test.ts` (drift concept `supporter-coin-motion`).

    /** One tap's worth of turn. */
    private val oneTurn = (Math.PI * 2).toFloat()

    /** A 60 Hz frame. */
    private val frame = 1f / 60f

    /**
     * Taps the coin, runs frames until it owes nothing, and reports how much
     * turn was actually delivered and how long it took.
     *
     * [tapAfterFrames] queues another tap partway through, which is the case a
     * debt handles and a restart cannot.
     */
    private fun turnsDelivered(
        taps: Int,
        tapAfterFrames: Set<Int> = emptySet(),
    ): Pair<Float, Int> {
        val debt = CoinTapDebt()
        repeat(taps) { debt.tap() }
        var turned = 0f
        var frames = 0
        // A ceiling, so a payout that never terminates fails as a test rather
        // than hanging the suite.
        while (debt.outstanding > 0f && frames < 6000) {
            if (frames in tapAfterFrames) debt.tap()
            turned += debt.pay(frame)
            frames += 1
        }
        assertEquals("the debt must reach zero", 0f, debt.outstanding, 0f)
        return turned to frames
    }

    @Test
    fun `one tap turns the coin exactly once, and finishes`() {
        val (turned, frames) = turnsDelivered(taps = 1)

        assertEquals(oneTurn, turned, 1e-3f)
        // Just over a second: a flourish that coasts, not a wind-down.
        assertTrue("took $frames frames", frames < 80)
    }

    @Test
    fun `ten taps turn the coin ten times`() {
        val (turned, _) = turnsDelivered(taps = 10)

        assertEquals(oneTurn * 10, turned, 1e-2f)
    }

    @Test
    fun `a tap that lands while an earlier one is still being paid is kept`() {
        val (turned, _) = turnsDelivered(taps = 1, tapAfterFrames = setOf(3))

        assertEquals(oneTurn * 2, turned, 1e-2f)
    }

    @Test
    fun `however much is owed, the payout never strobes`() {
        // Fifty turns owed would open at 942 rad/s uncapped, which is fifteen
        // turns in a single 60 Hz frame: a coin that reads as stationary.
        assertTrue(tapTurnPayout(oneTurn * 50, frame) < oneTurn / 2)
    }

    @Test
    fun `an untapped coin owes nothing and is paid nothing`() {
        val debt = CoinTapDebt()

        assertEquals(0f, debt.outstanding, 0f)
        assertEquals(0f, debt.pay(frame), 0f)
    }
}
