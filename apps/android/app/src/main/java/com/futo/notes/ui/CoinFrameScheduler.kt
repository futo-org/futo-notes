package com.futo.notes.ui

import android.view.Choreographer

internal fun interface CoinFrame {
    fun render(frameTimeNanos: Long): Boolean
}

internal interface CoinFrameScheduler {
    fun startCoinFrames(frame: CoinFrame): Unit
    fun stopCoinFrames(): Unit
}

internal class ChoreographerCoinFrames : CoinFrameScheduler {
    private val choreographer = Choreographer.getInstance()
    private var running: Choreographer.FrameCallback? = null

    override fun startCoinFrames(frame: CoinFrame): Unit {
        if (running != null) return
        val callback = object : Choreographer.FrameCallback {
            override fun doFrame(frameTimeNanos: Long) {
                // Choreographer still dispatches a callback removed during its own frame.
                if (running !== this) return
                choreographer.postFrameCallback(this)
                frame.render(frameTimeNanos)
            }
        }
        running = callback
        choreographer.postFrameCallback(callback)
    }

    override fun stopCoinFrames(): Unit {
        running?.let(choreographer::removeFrameCallback)
        running = null
    }
}
