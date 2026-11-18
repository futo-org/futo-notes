package com.futo.notes.textfirst

import android.os.Build
import android.os.SystemClock
import android.view.Choreographer
import android.view.HapticFeedbackConstants
import android.view.MotionEvent
import kotlin.math.hypot

// Long-press block drag (#444; #311 holds the design, the iOS build is the reference). With no
// text field of the note's screen focused, a press that holds still lifts what the engine says
// a press at the position under the finger lifts (a photo sharing its line alone, else the
// line's block): a card of it follows the finger, the source dims in place, a drop line marks
// the engine's slot nearest the finger, and releasing moves it there as one Undo step
// (EditorEngineBlocks.kt). While a field is focused every long-press is the platform's. The view
// decides only which position is under the finger and which slot is nearest. UI thread.

/** The drag's feel: an impact at the lift, a tick each time the finger brings the drop line to a new slot, a lighter one when the block lands. */
internal interface DragHaptics {
    fun lifted()
    fun reachedSlot()
    fun landed()
}

private class ViewDragHaptics(private val view: TextFirstEditText) : DragHaptics {
    override fun lifted() { view.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS) }
    override fun reachedSlot() {
        view.performHapticFeedback(if (Build.VERSION.SDK_INT >= 34) HapticFeedbackConstants.SEGMENT_FREQUENT_TICK else HapticFeedbackConstants.CLOCK_TICK)
    }
    override fun landed() {
        view.performHapticFeedback(if (Build.VERSION.SDK_INT >= 30) HapticFeedbackConstants.GESTURE_END else HapticFeedbackConstants.VIRTUAL_KEY)
    }
}

/** How a press lifts a block: the web editor's hold and tolerance (dp, as its CSS px). */
internal object LiftPolicy {
    const val HOLD_MS = 340L
    const val TOLERANCE_DP = 10f
}

/**
 * The note view's long-press lift and the drag it starts. It sees every touch first: it only
 * watches until a press has held [LiftPolicy.HOLD_MS] and the engine named a block under it,
 * then owns the gesture to its end, so the view's other handlers and the platform get a CANCEL
 * and nothing more.
 */
internal class BlockLift(private val view: TextFirstEditText) {
    private enum class Phase { Idle, Holding, Asking, Declined, Dragging, Spent }

    internal var haptics: DragHaptics = ViewDragHaptics(view)
    private var phase = Phase.Idle
    private var touch = 0
    private var pointer = -1
    private var downX = 0f
    private var downY = 0f
    private var fingerX = 0f
    private var fingerY = 0f
    private var downTime = 0L
    private var platformLongPress: (() -> Boolean)? = null
    private val hold = Runnable { ask() }
    private val tolerance get() = LiftPolicy.TOLERANCE_DP * view.style.density

    /** The drag on screen, until its card is gone. */
    internal var drag: BlockDrag? = null
        private set

    /** Whether a press may lift anything, before the line under it is asked. */
    private fun mayLift(): Boolean =
        view.engine != null && view.layout != null && view.isEnabled && !view.isFocused && !view.scroll.coasting && view.liftAllowed()

    /** True while this press is the drag's: the view's other handlers and the platform must not see [e]. */
    fun onTouch(e: MotionEvent): Boolean {
        when (e.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                clear()
                touch++
                if (drag != null) drag?.let { finish(it, returning = false) }
                if (mayLift()) {
                    phase = Phase.Holding
                    pointer = e.getPointerId(0)
                    downX = e.x; downY = e.y; fingerX = e.x; fingerY = e.y
                    downTime = e.downTime
                    view.postDelayed(hold, LiftPolicy.HOLD_MS)
                }
            }
            MotionEvent.ACTION_MOVE -> {
                val i = e.findPointerIndex(pointer)
                if (i >= 0) {
                    fingerX = e.getX(i); fingerY = e.getY(i)
                    when (phase) {
                        Phase.Holding, Phase.Asking ->
                            if (hypot(fingerX - downX, fingerY - downY) > tolerance || view.scroll.dragging) decline(platform = false)
                        Phase.Dragging -> follow(fromFinger = true)
                        else -> Unit
                    }
                }
            }
            // A second finger before the lift is no long press; during a drag it is ignored.
            MotionEvent.ACTION_POINTER_DOWN -> if (phase == Phase.Holding || phase == Phase.Asking) decline(platform = false)
            MotionEvent.ACTION_POINTER_UP -> if (phase == Phase.Dragging && e.getPointerId(e.actionIndex) == pointer) release(drop = true)
            MotionEvent.ACTION_UP -> {
                if (phase == Phase.Dragging) release(drop = true)
                val owned = phase == Phase.Spent
                clear()
                return owned
            }
            MotionEvent.ACTION_CANCEL -> {
                if (phase == Phase.Dragging) release(drop = false)
                val owned = phase == Phase.Spent
                clear()
                return owned
            }
        }
        return phase == Phase.Dragging || phase == Phase.Spent
    }

    /**
     * The platform's long press fired ([platform] runs it). While this press may still lift it
     * waits for the engine's answer and runs only if nothing lifts; a lifted press has none.
     */
    fun holdsLongPress(platform: () -> Boolean): Boolean = when (phase) {
        Phase.Holding, Phase.Asking -> { platformLongPress = platform; true }
        Phase.Dragging, Phase.Spent -> true
        else -> false
    }

    /** The note's text changed: a drag (or a lift being asked for) ends at once with nothing moved. */
    fun noteChanged() {
        if (phase == Phase.Asking) decline(platform = false)
        if (phase == Phase.Dragging) cancel()
    }

    /** The system took the touch, the window lost focus or the note is closing: end with nothing moved. */
    fun interrupt() {
        when (phase) {
            Phase.Holding, Phase.Asking -> decline(platform = false)
            Phase.Dragging -> cancel()
            else -> Unit
        }
    }

    /** The text or its layout moved under the drag: measure again. */
    fun relayout() { if (phase == Phase.Dragging) follow(fromFinger = false) }

    /** The dropped block's update landed in this frame: the card and the dim go with it. */
    fun landed() { drag?.let { if (it.landing) finish(it, returning = false) } }

    private fun clear() {
        view.removeCallbacks(hold)
        platformLongPress = null
        stopAutoscroll()
        phase = Phase.Idle
    }

    private fun decline(platform: Boolean) {
        view.removeCallbacks(hold)
        phase = Phase.Declined
        val longPress = platformLongPress
        platformLongPress = null
        if (platform) longPress?.invoke()
    }

    private fun ask() {
        if (phase != Phase.Holding) return
        val engine = view.engine ?: return decline(platform = true)
        val press = view.pressOffset(fingerX, fingerY) ?: return decline(platform = true)
        val near = view.visibleChars() ?: return decline(platform = true)
        phase = Phase.Asking
        val asked = touch
        engine.planLift(view.appliedSeq, press, near.first..minOf(near.last, view.length() - 1)) { plan ->
            if (asked != touch || phase != Phase.Asking) return@planLift
            if (plan == null || plan.seq != view.appliedSeq || view.engine !== engine) decline(platform = true)
            else begin(plan)
        }
    }

    private fun begin(plan: LiftPlan) {
        val created = BlockDrag.lift(view, plan, fingerX, fingerY) ?: return decline(platform = true)
        platformLongPress = null
        phase = Phase.Dragging
        view.cancelLongPress()
        val cancel = MotionEvent.obtain(downTime, SystemClock.uptimeMillis(), MotionEvent.ACTION_CANCEL, fingerX, fingerY, 0)
        try { view.routeTouch(cancel) } finally { cancel.recycle() }
        view.parent?.requestDisallowInterceptTouchEvent(true)
        drag = created
        haptics.lifted()
        created.attach()
        created.enter()
        follow(fromFinger = false)
    }

    private fun follow(fromFinger: Boolean) {
        val d = drag ?: return
        if (d.follow(fingerX, fingerY) && fromFinger) haptics.reachedSlot()
        fetchSlots()
        autoscrollVelocity = BlockAutoscroll.velocity(fingerY, 0f, view.height.toFloat(), view.style.density)
        if (autoscrollVelocity != 0f) startAutoscroll()
        d.invalidate()
    }

    /** Ask the engine for the slots of what newly came near the screen. */
    private fun fetchSlots() {
        val d = drag ?: return
        if (d.fetching) return
        val near = view.visibleChars() ?: return
        val (asks, covering) = d.book.missing(near.first..minOf(near.last, view.length() - 1))
        if (asks.isEmpty()) return
        val engine = view.engine ?: return
        d.fetching = true
        engine.moreSlots(d.plan.press, d.plan.revision, asks) { found ->
            d.fetching = false
            if (drag !== d || phase != Phase.Dragging) return@moreSlots
            if (found == null) return@moreSlots cancel()
            d.book.add(found, covering)
            follow(fromFinger = false)
        }
    }

    private fun release(drop: Boolean) {
        val d = drag ?: return
        stopAutoscroll()
        phase = Phase.Spent
        val slot = d.slot?.takeIf { drop }
        val engine = view.engine
        if (slot == null || engine == null) return finish(d, returning = true)
        d.landing = true
        d.invalidate()
        engine.dropBlock(d.plan.press, slot, d.plan.revision, d.holdFor(slot)) { moved ->
            if (moved) haptics.landed()
            if (drag === d) finish(d, returning = !moved)
        }
    }

    /** End the drag in progress at once, silently, the finger still down: nothing it does until it lifts is a drag. */
    private fun cancel() {
        stopAutoscroll()
        phase = Phase.Spent
        drag?.let { finish(it, returning = false) }
    }

    private fun finish(d: BlockDrag, returning: Boolean) {
        d.landing = false
        if (!returning) {
            d.dispose()
            if (drag === d) drag = null
            view.invalidate()
            return
        }
        d.returnHome { d.dispose(); if (drag === d) { drag = null; view.invalidate() } }
    }

    // ---- the edge autoscroll ----

    private var autoscrollVelocity = 0f
    private var autoscrolling = false
    private var lastFrame = 0L
    private var remainder = 0f
    private val frame = Choreographer.FrameCallback { now -> autoscrollFrame(now) }

    private fun startAutoscroll() {
        if (autoscrolling) return
        autoscrolling = true
        lastFrame = 0L
        remainder = 0f
        Choreographer.getInstance().postFrameCallback(frame)
    }

    private fun stopAutoscroll() {
        autoscrollVelocity = 0f
        if (!autoscrolling) return
        autoscrolling = false
        Choreographer.getInstance().removeFrameCallback(frame)
    }

    private fun autoscrollFrame(now: Long) {
        if (!autoscrolling || phase != Phase.Dragging || autoscrollVelocity == 0f) { autoscrolling = false; return }
        if (lastFrame != 0L) {
            remainder += BlockAutoscroll.step(autoscrollVelocity, (now - lastFrame) / 1e9f)
            val dy = remainder.toInt()
            remainder -= dy
            val before = view.scrollY
            if (dy != 0) view.scroll.dragBy(dy)
            // The note moved under a still finger: the drop line follows the slot now nearest it, without a tick.
            if (view.scrollY != before) follow(fromFinger = false)
        }
        lastFrame = now
        if (autoscrolling) Choreographer.getInstance().postFrameCallback(frame)
    }
}
