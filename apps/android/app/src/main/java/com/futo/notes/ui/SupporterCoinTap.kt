package com.futo.notes.ui

/// A tap on the coin owes it one more full turn (@justin 2026-09-17).
///
/// Taps QUEUE, because what a tap adds is an ANGLE and not a restart: ten fast
/// taps are ten turns (@justin 2026-09-18). The obvious implementation — hold a
/// phase into a single timed turn and set it back to zero on every tap — is the
/// bug this replaced; it looks perfectly correct on one tap and swallows every
/// tap but the last on ten.
private const val TAP_TURN = (Math.PI * 2).toFloat()

/// How fast the debt is paid: radians per second for each radian still owed. One
/// turn owed opens at ~19 rad/s and is nine tenths paid in three quarters of a
/// second.
private const val TAP_PAYOUT = 3f

/// Ceiling on the payout rate. Ten queued turns owe 63 radians, which without
/// this would open at 188 rad/s: three turns in a single frame, i.e. a coin that
/// looks stationary or strobing.
private const val TAP_MAX_RATE = 26f

/// Floor on the payout rate, so the tail is a coast rather than an asymptote. A
/// purely proportional payout spends its last second turning the coin by
/// fractions of a degree.
private const val TAP_MIN_RATE = 2f

/// Below this the rest of the debt is handed over in one frame: half a degree is
/// not a turn, and the debt has to actually reach zero.
private const val TAP_SETTLE = 0.01f

/// A press is a tap and not a drag if the thumb barely moved and did not linger.
/// Both bounds matter: a 2dp wobble is still a tap, and a slow, deliberate 2dp
/// nudge held for a second is not.
internal const val TAP_MAX_MOVEMENT_DP = 5f
internal const val TAP_MAX_MILLISECONDS = 400L

/**
 * How much of an owed turn one frame pays off: fastest when the most is owed,
 * capped so a burst of taps cannot become a strobe, and handing over the last
 * sliver whole so the debt actually reaches zero.
 *
 * Internal for [SupporterCoinTest]. Everything the queue promises — that ten
 * taps turn the coin ten times, not once — is this function summing to exactly
 * the debt it was given. Desktop's `tapTurnPayout` is the same arithmetic in
 * TypeScript (drift concept `supporter-coin-motion`), and iOS's is the same in
 * Swift.
 */
internal fun tapTurnPayout(debt: Float, seconds: Float): Float {
    if (debt <= 0f) return 0f
    val rate = (debt * TAP_PAYOUT).coerceIn(TAP_MIN_RATE, TAP_MAX_RATE)
    val paid = rate * seconds
    return if (debt - paid <= TAP_SETTLE) debt else paid
}

/**
 * The angle the coin owes its taps.
 *
 * This tiny object is the whole difference between "ten taps are ten turns" and
 * the bug it replaced. [tap] ADDS a turn; it does not set one. The version this
 * replaced held a phase into a single timed turn and put it back to zero on
 * every tap, which is indistinguishable from this on one tap and swallows nine
 * taps out of ten on a burst.
 *
 * Separate from [CoinScene] because the scene needs a GL context and this does
 * not: `SupporterCoinTest` drives the queue frame by frame on the JVM. iOS keeps
 * the same object as `CoinTapDebt` in `SupporterCoin.swift`.
 */
internal class CoinTapDebt {
    /** Radians still owed. Exposed so a test can watch the debt reach zero. */
    var outstanding = 0f
        private set

    /** One more full turn, on top of whatever is already owed. */
    fun tap() {
        outstanding += TAP_TURN
    }

    /**
     * Pays down the debt and answers how much turn that buys this frame. The
     * only way the debt ever leaves, which is what makes "no tap is dropped" a
     * property of the code rather than a hope.
     */
    fun pay(seconds: Float): Float {
        val paid = tapTurnPayout(outstanding, seconds)
        outstanding -= paid
        return paid
    }
}
