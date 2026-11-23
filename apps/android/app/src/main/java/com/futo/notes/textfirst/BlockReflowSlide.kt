package com.futo.notes.textfirst

import android.view.animation.PathInterpolator

/** A part of the preview sliding from [from] to [to] px over [ms], started at [start] (uptime ms). */
internal class Slide(val from: Float, val to: Float, val start: Long, private val ms: Long = SLIDE_MS) {
    fun at(now: Long): Float {
        val t = (now - start).toFloat() / ms
        return if (t >= 1f || from == to) to else from + (to - from) * EASE.getInterpolation(t.coerceAtLeast(0f))
    }
    fun moving(now: Long) = from != to && now - start < ms
    fun toward(target: Float, now: Long) = if (target == to) this else Slide(at(now), target, now)

    companion object {
        /** Neighbours slide over 180 ms with the web editor's easing. */
        const val SLIDE_MS = 180L
        private val EASE = PathInterpolator(0.2f, 0.9f, 0.3f, 1f)
        fun still(at: Float) = Slide(at, at, 0L)
    }
}
