package com.futo.notes.textfirst

import android.os.Build
import android.os.SystemClock
import android.view.Choreographer
import android.view.HapticFeedbackConstants
import android.view.MotionEvent
import android.view.ViewTreeObserver
import kotlin.math.hypot

// Long-press block drag (#444, reflow #450; #311 holds the design, the iOS build is the
// reference). With no text field of the note's screen focused, a press that holds still lifts
// what the engine says a press at the position under the finger lifts (a photo sharing its line
// alone, else the line's block): a card of it follows the finger and the note reflows around a
// gap at the slot the finger chose (BlockReflowPreview.kt), or, with animations off, the source
// dims in place and a drop line marks the slot nearest the finger. Releasing moves it there as
// one Undo step (EditorEngineBlocks.kt). While a field is focused every long-press is the
// platform's. The view decides only which position is under the finger and which slot it
// chose. UI thread.

/** The drag's feel: an impact at the lift, a tick each time the finger brings the gap (or drop line) to a new slot, a lighter one when the block lands. */
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

    /** Whether the edge autoscroll is asking for frames. */
    internal val autoscrollRunning get() = autoscrolling

    /** The drag on screen, until its card is gone. */
    internal var drag: BlockDrag? = null
        private set

    /**
     * A drop the editor has still to make, from the release until it is made or refused: the
     * note takes no input meanwhile (a tap, a box, a hold), whose offsets the move is about to
     * change, though the preview may already be gone (its 400 ms cap).
     */
    private var pendingDrop: EditorEngine? = null

    /** A gesture that went down while input waited: the rest of it is swallowed too, so no handler sees an UP without its DOWN. */
    private var swallowing = false

    /** Whether a press may lift anything, before the line under it is asked: a finger (not a stylus, eraser or mouse), with no field focused. */
    private fun mayLift(e: MotionEvent): Boolean =
        e.getToolType(0) !in NOT_A_FINGER &&
            view.engine != null && view.layout != null && view.isEnabled && !view.isFocused && !view.scroll.coasting && view.liftAllowed()

    /** True while this press is the drag's: the view's other handlers and the platform must not see [e]. */
    fun onTouch(e: MotionEvent): Boolean {
        if (e.actionMasked == MotionEvent.ACTION_DOWN) swallowing = false
        pendingDrop?.let {
            if (it !== view.engine) { pendingDrop = null; return@let }
            when (e.actionMasked) {
                MotionEvent.ACTION_DOWN -> swallowing = true
                // The gesture that dropped ends here (a second finger lifting last): nothing of it stays armed.
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> clear()
            }
            return true
        }
        if (swallowing) {
            if (e.actionMasked == MotionEvent.ACTION_UP || e.actionMasked == MotionEvent.ACTION_CANCEL) swallowing = false
            return true
        }
        when (e.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                clear()
                touch++
                // A preview still landing or sliding home draws rows where the layout does not have them: a press on one
                // would hit another. It is not cut short, and nothing lifts until it ends (#450).
                if (drag?.let { it.landing || it.reflow != null } == true) { swallowing = true; return true }
                drag?.let { finish(it, returning = false) }
                if (mayLift(e)) {
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
            // The lifting finger leaving drops the block, unless Android withdrew that contact (a palm).
            MotionEvent.ACTION_POINTER_UP -> if (phase == Phase.Dragging && e.getPointerId(e.actionIndex) == pointer) release(drop = !e.canceled())
            MotionEvent.ACTION_UP -> {
                if (phase == Phase.Dragging) release(drop = !e.canceled())
                // Released while the engine is still answering: the platform's long press it held for comes now, before its lift.
                if (phase == Phase.Holding || phase == Phase.Asking) platformLongPress?.let { platformLongPress = null; it() }
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

    /**
     * The view applied an update made at engine [revision]: any change to the note (an edit,
     * another block's move, a reload) ends a drag lifted at another revision at once, with
     * nothing moved, as its drop would be refused.
     */
    fun revisionSeen(revision: ULong) {
        if (phase == Phase.Dragging && drag?.plan?.revision != revision) cancel()
        // Another change while the moved block slides home: the preview ends at once.
        drag?.let { d -> if (d.landedAt != null && d.landedAt != revision) finish(d, returning = false) }
    }

    /** A scroll (the note's or a table's) claimed this contact: it lifts nothing. */
    fun scrollClaimed() { if (phase == Phase.Holding || phase == Phase.Asking) decline(platform = false) }

    /** The system took the touch, the window lost focus or the note is closing: end with nothing moved. */
    fun interrupt() {
        when (phase) {
            Phase.Holding, Phase.Asking -> decline(platform = false)
            Phase.Dragging -> cancel()
            else -> Unit
        }
        // A card still sliding home or landing goes with it.
        drag?.let { finish(it, returning = false) }
    }

    /** The text or its layout moved under the drag: measure again. */
    fun relayout() {
        // A photo decoding or a new width: the preview's recorded drawing is stale, before or after the release.
        drag?.reflow?.remeasure()
        if (phase == Phase.Dragging) follow(fromFinger = false)
    }

    /**
     * The dropped block's update (engine [revision]) landed in this frame: the card and the dim
     * go with it, or the reflow preview is drawn from the moved note and slides home first.
     */
    fun landed(revision: ULong) {
        val d = drag?.takeIf { it.landing } ?: return
        val reflow = d.reflow
        val landing = d.capture?.land(view) { if (drag === d) finish(d, returning = false) }
        if (reflow == null || landing == null) return finish(d, returning = false)
        d.landedAt = revision
        reflow.landing = landing
        view.invalidate()
    }

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
        if (view.scroll.dragging || view.tableTouch.scrolling) return decline(platform = false)
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
        // Any scroll (a restore after a resize, not only autoscroll) moves the destination under the still finger; focus ends the drag.
        view.viewTreeObserver.addOnScrollChangedListener(scrolled)
        view.viewTreeObserver.addOnGlobalFocusChangeListener(focused)
        // No text menu can open during a drag: the rest of a note still streaming in keeps coming, in its bounded slices.
        view.renderHold.dragging(true)
        haptics.lifted()
        created.attach()
        created.enter()
        follow(fromFinger = false)
    }

    private var lastScroll = 0
    private val scrolled = ViewTreeObserver.OnScrollChangedListener {
        if (phase == Phase.Dragging && view.scrollY != lastScroll) follow(fromFinger = false)
    }
    /** A field of the screen (or the body) took focus mid-drag: no drag with the keyboard up, cancelled before any engine call. */
    private val focused = ViewTreeObserver.OnGlobalFocusChangeListener { _, _ -> if (phase == Phase.Dragging && !keyboardDown()) cancel() }
    private fun keyboardDown() = !view.isFocused && view.liftAllowed()

    private fun follow(fromFinger: Boolean) {
        lastScroll = view.scrollY
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
        // A field focused since the lift (the keyboard up): nothing moves.
        val engine = view.engine?.takeIf { keyboardDown() }
        d.reflow?.let { reflow ->
            // Only a slot the preview shows now: a view cut for a new width may no longer hold it.
            val slot = reflow.target?.takeIf { drop }
            // The card goes at once; the copy turns solid and the move is made under the preview.
            d.dropCard()
            if (slot == null || engine == null) return reflow.settleHome { if (drag === d) finish(d, returning = false) }
            d.capture = reflow.release()
            d.landing = true
            // The preview ends by the cap even while the editor is still to make the move; the note's input waits for it.
            d.later(ReflowCapture.LANDING_CAP_MS) { if (drag === d) finish(d, returning = false) }
            pendingDrop = engine
            engine.dropBlock(d.plan.press, slot, d.plan.revision, DropHold.KEEP) { moved ->
                if (pendingDrop === engine) pendingDrop = null
                if (moved) haptics.landed() else if (drag === d) reflow.settleHome { if (drag === d) finish(d, returning = false) }
                // Moved, but no update reached the view (it was cut short for a new width): end here.
                if (moved && drag === d && d.landedAt == null) finish(d, returning = false)
            }
            return
        }
        // Only a drop line on screen, with the lifted block laid out (not after a cut for a new width).
        val slot = d.shownSlot()?.takeIf { drop }
        if (slot == null || engine == null) return finish(d, returning = true)
        d.landing = true
        d.invalidate()
        pendingDrop = engine
        engine.dropBlock(d.plan.press, slot, d.plan.revision, d.holdFor(slot)) { moved ->
            if (pendingDrop === engine) pendingDrop = null
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
        view.viewTreeObserver.removeOnScrollChangedListener(scrolled)
        view.viewTreeObserver.removeOnGlobalFocusChangeListener(focused)
        view.renderHold.dragging(false)
        d.landing = false
        if (!returning) {
            d.dispose()
            if (drag === d) drag = null
            // A preview drawn taller than the note may have let autoscroll past its end.
            view.clampScrollToNote()
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
        // At the note's end in that direction there is nothing to scroll: no frames.
        if (autoscrolling || !canScroll(autoscrollVelocity)) return
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

    private fun canScroll(velocity: Float) = if (velocity < 0) view.scrollY > 0 else view.scrollY < view.maxScrollY()

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
            // Stopped at an end: no more frames until the finger or the layout makes room to scroll.
            else if (dy != 0) { autoscrolling = false; return }
        }
        lastFrame = now
        if (autoscrolling) Choreographer.getInstance().postFrameCallback(frame)
    }
}

private val NOT_A_FINGER = setOf(MotionEvent.TOOL_TYPE_STYLUS, MotionEvent.TOOL_TYPE_ERASER, MotionEvent.TOOL_TYPE_MOUSE)

private fun MotionEvent.canceled() = flags and MotionEvent.FLAG_CANCELED != 0
