package com.futo.notes.textfirst

internal class CaretEdgeHaptics {
    private var lastTickNanos: Long? = null

    fun allowLineTick(lineChanged: Boolean, linesPerSecond: Float, frameNanos: Long): Boolean {
        if (!lineChanged || linesPerSecond > MAX_LINES_PER_SECOND) return false
        val lastTick = lastTickNanos
        if (lastTick != null && frameNanos - lastTick < TICK_INTERVAL_NANOS) return false
        lastTickNanos = frameNanos
        return true
    }

    private companion object {
        const val MAX_LINES_PER_SECOND = 6
        const val TICK_INTERVAL_NANOS = 166_666_667L
    }
}
