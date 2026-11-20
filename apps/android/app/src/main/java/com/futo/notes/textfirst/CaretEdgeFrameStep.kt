package com.futo.notes.textfirst

internal class CaretEdgeFrameStep {
    private var remainder = 0.0

    fun reset(): Unit {
        remainder = 0.0
    }

    fun scrollPixels(velocity: Float, elapsedNanos: Long): Int {
        remainder += velocity.toDouble() * minOf(elapsedNanos, MAX_FRAME_NANOS) / 1_000_000_000
        val pixels = remainder.toInt()
        remainder -= pixels
        return pixels
    }

    companion object {
        /** A late frame keeps its full travel up to this; one long stall (a slice apply, a GC) is not one long jump. */
        const val MAX_FRAME_NANOS = 100_000_000L
    }
}
