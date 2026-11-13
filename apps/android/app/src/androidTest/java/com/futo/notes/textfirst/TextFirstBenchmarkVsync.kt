package com.futo.notes.textfirst

import android.os.SystemClock
import android.view.Choreographer

/**
 * Vsyncs while a note is measured, in elapsedRealtimeNanos, so a key can
 * say how many frames it missed: 0 = drawn in the first frame that began
 * after the key was handed over. A blocked main thread delivers no
 * callbacks, so missed frames are counted in refresh periods, not callbacks.
 */
internal class VsyncRecorder : Choreographer.FrameCallback {
    private val times = LongArray(1 shl 16)
    @Volatile private var count = 0
    private var running = false
    private var periodNs = 16_666_667L

    fun start(refreshRate: Float) {
        periodNs = (1e9 / refreshRate).toLong()
        running = true
        Choreographer.getInstance().postFrameCallback(this)
    }
    fun stop() { running = false }

    override fun doFrame(frameTimeNanos: Long) {
        // Choreographer's clock is System.nanoTime; the key timings use elapsedRealtimeNanos.
        val vsync = SystemClock.elapsedRealtimeNanos() - (System.nanoTime() - frameTimeNanos)
        times[count and (times.size - 1)] = vsync
        count += 1
        if (running) Choreographer.getInstance().postFrameCallback(this)
    }

    fun framesLate(input: Long, drawStart: Long): Int {
        // The last vsync at or before the input, then the first after it.
        val n = count
        var before = input - periodNs
        for (i in n - 1 downTo maxOf(0, n - times.size)) {
            val v = times[i and (times.size - 1)]
            if (v <= input) { before = v; break }
        }
        var first = before + periodNs
        while (first <= input) first += periodNs
        return if (drawStart < first) 0 else ((drawStart - first) / periodNs).toInt()
    }
}
