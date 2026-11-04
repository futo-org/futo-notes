package com.futo.notes.textfirst

import android.view.MotionEvent
import android.view.VelocityTracker
import android.view.ViewConfiguration
import android.widget.OverScroller
import kotlin.math.abs
import kotlin.math.hypot

/**
 * Vertical scrolling of the note the way any Android list does it: a drag
 * follows the finger, a flick keeps going with the platform's fling curve, and
 * a touch on a moving note stops it. TextView's own movement method only drags,
 * and it decides "tap" from where the gesture ends, so a quick flick could place
 * the caret. Here a gesture that travels past the touch slop is never a tap.
 */
internal class NoteScroll(private val view: TextFirstEditText) {
    private val config = ViewConfiguration.get(view.context)
    private val slop = config.scaledTouchSlop
    private val scroller = OverScroller(view.context)
    private var tracker: VelocityTracker? = null
    private var downX = 0f
    private var downY = 0f
    private var lastY = 0f
    private var dragging = false
    /** The gesture began on a coasting note: it only stops the note, and is never a tap. */
    private var stopping = false

    val coasting get() = !scroller.isFinished

    fun stop() = scroller.abortAnimation()

    /** Called from the view's computeScroll. */
    fun step() {
        if (!scroller.computeScrollOffset()) return
        view.scrollTo(view.scrollX, scroller.currY.coerceIn(0, maxScroll()))
        view.postInvalidateOnAnimation()
    }

    private fun maxScroll() =
        ((view.layout?.height ?: 0) + view.totalPaddingTop + view.totalPaddingBottom - view.height).coerceAtLeast(0)

    /** Move the note by [dy] (positive = further down the note). */
    fun dragBy(dy: Int) {
        view.scrollTo(view.scrollX, (view.scrollY + dy).coerceIn(0, maxScroll()))
    }

    /** Begin a gesture. Called for every ACTION_DOWN, before anything else sees it. */
    fun down(event: MotionEvent) {
        tracker?.recycle()
        tracker = VelocityTracker.obtain().also { it.addMovement(event) }
        downX = event.x; downY = event.y; lastY = event.y
        dragging = false
        stopping = coasting
        if (stopping) {
            stop()
            view.cancelLongPress()
        }
    }

    /** Let the finger's path feed the fling velocity. */
    fun track(event: MotionEvent) { tracker?.addMovement(event) }

    /** Lift off after a vertical drag of the grid or the note: fling with the finger's velocity. */
    fun release() {
        val t = tracker ?: return
        t.computeCurrentVelocity(1000, config.scaledMaximumFlingVelocity.toFloat())
        val vy = -t.yVelocity
        t.recycle(); tracker = null
        if (abs(vy) < config.scaledMinimumFlingVelocity) return
        scroller.fling(view.scrollX, view.scrollY, 0, vy.toInt(), 0, 0, 0, maxScroll())
        view.postInvalidateOnAnimation()
    }

    /** True from a DOWN that landed on a coasting note until the finger lifts. */
    val stoppingTouch get() = stopping

    /**
     * True when this view owns the gesture, so the TextView must not see it.
     * [cancelNative] hands the TextView a CANCEL when ownership begins mid-gesture.
     * [down] and [track] have already seen the event.
     */
    fun own(event: MotionEvent, cancelNative: (MotionEvent) -> Unit): Boolean {
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> return stopping
            MotionEvent.ACTION_MOVE -> {
                if (!dragging && !beyondSlop(event)) return stopping
                if (!dragging && !stopping && isLongPress(event)) return false
                if (!dragging) begin(event, cancelNative)
                dragBy((lastY - event.y).toInt())
                lastY = event.y
                return true
            }
            MotionEvent.ACTION_UP -> {
                val owned = dragging || stopping || (beyondSlop(event) && !isLongPress(event))
                if (!owned) { clear(); return false }
                if (!dragging && !stopping) begin(event, cancelNative)
                if (dragging) { dragBy((lastY - event.y).toInt()); release() }
                clear()
                return true
            }
            MotionEvent.ACTION_CANCEL -> {
                val owned = dragging || stopping
                clear()
                return owned
            }
        }
        return dragging || stopping
    }

    private fun begin(event: MotionEvent, cancelNative: (MotionEvent) -> Unit) {
        dragging = true
        if (!stopping) {
            val cancel = MotionEvent.obtain(event)
            cancel.action = MotionEvent.ACTION_CANCEL
            try { cancelNative(cancel) } finally { cancel.recycle() }
        }
        view.cancelLongPress()
        view.parent?.requestDisallowInterceptTouchEvent(true)
    }

    private fun clear() {
        tracker?.recycle(); tracker = null
        dragging = false
        stopping = false
    }

    private fun beyondSlop(event: MotionEvent) = hypot(event.x - downX, event.y - downY) > slop

    private fun isLongPress(event: MotionEvent) = event.eventTime - event.downTime >= ViewConfiguration.getLongPressTimeout()
}
