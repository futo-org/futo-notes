package com.futo.notes.ui

import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.sin
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The supporter coin's projection law, which is subtle in exactly one place.
 *
 * The coin is drawn as two projected faces with the extruded wall filling the
 * part of the silhouette neither of them covers. That wall is the hull of the two
 * faces MINUS the faces, so it normally sits at the silhouette's vertical
 * extremes, nowhere near the diamond. But once the faces are narrower than the
 * gap between them, the wall reaches the middle and closes the diamond over. That
 * is correct exactly at edge-on — you cannot see through a hole you are looking
 * along — and wrong everywhere else, where it would turn the FUTO coin into a
 * disc with a diamond painted on it rather than punched through it.
 *
 * So the law worth locking is where that crossover sits: within a couple of
 * degrees of edge-on, and nowhere in the turn a user actually watches. The first
 * cut of this view put it at 30°.
 *
 * The same law is written again in Swift
 * (`apps/ios/Sources/License/SupporterCoin.swift`); drift concept
 * `supporter-coin-projection` records that pairing.
 */
class SupporterCoinTest {
    /** A 160dp coin on a 2.75-density phone, which is the real case. */
    private val box = 440f

    private fun facesCoverTheCentre(degrees: Double): Boolean {
        val radians = Math.toRadians(degrees)
        val squeeze = maxOf(abs(cos(radians).toFloat()), MIN_SQUEEZE)
        return faceHalfWidth(box, squeeze) >= abs(halfSeparation(box, sin(radians).toFloat()))
    }

    @Test
    fun `the wall stays clear of the diamond through every ordinary viewing angle`() {
        for (degrees in 0..85) {
            assertTrue(
                "at $degrees° the faces no longer reach the centre, so the wall fills the diamond",
                facesCoverTheCentre(degrees.toDouble()),
            )
        }
    }

    @Test
    fun `the wall does close the diamond over at edge-on, where a through-hole is occluded`() {
        assertTrue("edge-on must be solid", !facesCoverTheCentre(90.0))
    }

    @Test
    fun `there is no wall at all face-on, where the coin has no visible edge`() {
        assertEquals(0f, halfSeparation(box, sin(0.0).toFloat()), 1e-6f)
    }

    @Test
    fun `the widest the coin's edge ever looks is its full thickness`() {
        // Edge-on, the gap between the faces is the whole depth: R/3 of the disc's
        // diameter, per supporterCoin.ts's DEPTH = OUTER_RADIUS / 6.
        val edgeOn = abs(halfSeparation(box, 1f)) * 2
        assertEquals(box * DEPTH_FRACTION, edgeOn, 1e-3f)
    }

    @Test
    fun `the coin's proportions are the ones the shared three-js coin uses`() {
        // supporterCoin.ts: OUTER_RADIUS 22 in a 48 box, DEPTH = OUTER_RADIUS / 6.
        assertEquals(22f / 48f, DISC_RADIUS_FRACTION, 1e-6f)
        assertEquals(DISC_RADIUS_FRACTION / 6f, DEPTH_FRACTION, 1e-6f)
    }
}
