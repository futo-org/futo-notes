package com.futo.notes.ui

import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.sin
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
 */
class SupporterCoinTest {
    private val tilt = 0.24f

    /** Column `index` of the column-major 4x4 as an (x, y, z) triple. */
    private fun column(matrix: FloatArray, index: Int) =
        Triple(matrix[index * 4], matrix[index * 4 + 1], matrix[index * 4 + 2])

    private fun length(v: Triple<Float, Float, Float>) =
        hypot(hypot(v.first, v.second), v.third)

    private fun dot(a: Triple<Float, Float, Float>, b: Triple<Float, Float, Float>) =
        a.first * b.first + a.second * b.second + a.third * b.third

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

    @Test
    fun `the spindle leans by exactly the tilt`() {
        val spindle = column(tiltedSpin(tilt, 1.9f), 1)
        // Angle from straight up (0, 1, 0).
        val leanCosine = dot(spindle, Triple(0f, 1f, 0f)) / length(spindle)
        assertEquals(cos(tilt), leanCosine, 1e-5f)
    }

    @Test
    fun `face-on at rest and edge-on a quarter turn later`() {
        // The model's +Z is its face normal, and the camera looks down -Z from
        // +Z, so a face-on coin has its normal pointing at the camera.
        val atRest = column(tiltedSpin(tilt, 0f), 2)
        assertEquals("tilted away from the camera by the tilt only", cos(tilt), atRest.third, 1e-5f)

        val quarter = column(tiltedSpin(tilt, (Math.PI / 2).toFloat()), 2)
        assertTrue(
            "a quarter turn should put the face edge-on, got z=${quarter.third}",
            abs(quarter.third) < 1e-5f,
        )
    }

    @Test
    fun `it is a rotation, not a skew`() {
        val matrix = tiltedSpin(tilt, 2.2f)
        val axes = listOf(column(matrix, 0), column(matrix, 1), column(matrix, 2))
        for ((index, axis) in axes.withIndex()) {
            assertEquals("column $index is a unit vector", 1f, length(axis), 1e-5f)
        }
        assertEquals("columns 0 and 1 stay perpendicular", 0f, dot(axes[0], axes[1]), 1e-5f)
        assertEquals("columns 1 and 2 stay perpendicular", 0f, dot(axes[1], axes[2]), 1e-5f)
        assertEquals("columns 0 and 2 stay perpendicular", 0f, dot(axes[0], axes[2]), 1e-5f)
        // Right-handed: column0 x column1 == column2, or the coin renders inside out.
        val (ax, ay, az) = axes[0]
        val (bx, by, bz) = axes[1]
        val cross = Triple(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx)
        assertEquals(axes[2].first, cross.first, 1e-5f)
        assertEquals(axes[2].second, cross.second, 1e-5f)
        assertEquals(axes[2].third, cross.third, 1e-5f)
    }

    @Test
    fun `the translation column is untouched`() {
        // The coin turns about its own centre; anything in the translation column
        // would make it orbit one instead.
        val matrix = tiltedSpin(tilt, 3.3f)
        assertEquals(0f, matrix[12], 0f)
        assertEquals(0f, matrix[13], 0f)
        assertEquals(0f, matrix[14], 0f)
        assertEquals(1f, matrix[15], 0f)
    }

    private operator fun <A, B, C> Triple<A, B, C>.component1() = first
    private operator fun <A, B, C> Triple<A, B, C>.component2() = second
    private operator fun <A, B, C> Triple<A, B, C>.component3() = third
}
