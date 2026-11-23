package com.futo.notes.textfirst

internal class CaretEdgeFrameStep {
    private var remainder = 0.0

    fun reset(): Unit {
        remainder = 0.0
    }

    fun scrollPixels(velocity: Float, elapsedNanos: Long): Int {
        remainder += velocity.toDouble() * minOf(elapsedNanos, LONGEST_FRAME_NANOS) / 1_000_000_000
        val pixels = remainder.toInt()
        remainder -= pixels
        return pixels
    }

    private companion object {
        val LONGEST_FRAME_NANOS = (BlockAutoscroll.LONGEST_FRAME_S * 1_000_000_000).toLong()
    }
}
