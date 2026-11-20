package com.futo.notes.textfirst

import android.text.Selection
import android.view.Choreographer
import android.view.MotionEvent
import android.view.ViewConfiguration

/**
 * A caret or selection end carried to the note's top or bottom edge scrolls the note at the block drag's ramp
 * (BlockAutoscroll) for as long as the finger stays in the edge zone, whatever is under it (a photo taller than the
 * zone, a code block, a table), and the end lands on the caret stop nearest the finger (A4, Mason S23). The
 * platform's own scroll waits for the caret to reach a line beyond the edge, one line a touch event, and never
 * passes a row taller than its slop. A hold-and-drag selection is driven from the note's own touches, a handle from
 * HandleWatch; anything else keeps the platform's behaviour. UI thread.
 */
internal class CaretEdgeScroll(private val view: TextFirstEditText) {
    internal enum class End { CARET, START, END }

    private var end: End? = null
    private var fingerX = 0f
    private var fingerY = 0f
    /** From the finger to where the dragged end's caret is drawn: a handle is held below its caret. */
    private var reach = 0f
    /** The selection's other end, where it was when the drag began: the dragged end may cross it, as a handle can. */
    private var anchor = -1
    /** Whether the dragged end has crossed the other: the platform's handle no longer moves the end it holds. */
    var crossed = false
        private set
    /** The range a hold selected before it dragged: its far end stays put whichever way the drag goes. */
    private var held = 0..0
    private var velocity = 0f
    var isDriving = false
        private set
    private var lastFrame = 0L
    private val frameStep = CaretEdgeFrameStep()
    private val frame = Choreographer.FrameCallback { now -> step(now) }

    private var downTime = 0L
    private var selectionAtDown = -1 to -1
    private var holdDragging = false
    private var pointer = -1

    /** The end a finger carries now; null with none. */
    val grabbed: End? get() = end

    /**
     * A finger at ([x], [y]), the note's coordinates, takes the selection's [end]; [belowCaret] when it holds a handle
     * drawn under its caret (the gap kept as it moves), not the text itself. The other end stays at [anchorAt], by
     * default where it is now.
     */
    fun grab(end: End, x: Float, y: Float, belowCaret: Boolean, anchorAt: Int? = null) {
        stop()
        this.end = end
        crossed = false
        reach = if (belowCaret) caretRowOf(end) - y else 0f
        anchor = anchorAt ?: when (end) {
            End.START -> maxOf(view.selectionStart, view.selectionEnd)
            End.END -> minOf(view.selectionStart, view.selectionEnd)
            End.CARET -> -1
        }
        fingerX = x
        fingerY = y
    }

    /** The grabbed end's finger is at ([x], [y]); true while that scrolls the note. */
    fun follow(x: Float, y: Float): Boolean {
        if (end == null) return false
        fingerX = x
        fingerY = y
        velocity = BlockAutoscroll.velocity(y, 0f, view.height.toFloat(), view.style.density)
        // Out of the zones a crossed end follows the finger here: its handle no longer moves it.
        if (velocity == 0f) { stop(); if (crossed) land(); return false }
        if (velocity < 0 && view.scrollY == 0 || velocity > 0 && view.scrollY >= view.maxScrollY()) return false
        if (isDriving) return true
        isDriving = true
        lastFrame = 0L
        frameStep.reset()
        Choreographer.getInstance().postFrameCallback(frame)
        return true
    }

    /**
     * Whether the row the grabbed end lands on is taller than two text lines (a photo): there the platform's handle
     * would step its end back to that row; over text it lands where the scroll does and keeps its magnifier on it.
     */
    fun isOverTallRow(): Boolean {
        val l = view.layout ?: return false
        val line = l.getLineForVertical((landingY() - view.totalPaddingTop + view.scrollY).toInt().coerceAtLeast(0))
        return l.getLineBottom(line) - l.getLineTop(line) > 2 * view.lineHeight
    }

    fun release() {
        end = null
        stop()
    }

    /** The note's own touches: a hold that selected and then drags extends its selection, as a handle would. */
    fun onNoteTouch(event: MotionEvent) {
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                downTime = event.downTime
                pointer = event.getPointerId(0)
                selectionAtDown = view.selectionStart to view.selectionEnd
                holdDragging = false
            }
            MotionEvent.ACTION_MOVE -> {
                val i = event.findPointerIndex(pointer)
                if (i < 0) return
                // A swipe the note's scroll already took is not a selection being dragged.
                if (!holdDragging) {
                    // Not a photo a hold selected whole: that is an object, not text being dragged.
                    holdDragging = !view.scroll.dragging && view.selectedObject == null && view.selectionStart != view.selectionEnd &&
                        (view.selectionStart to view.selectionEnd) != selectionAtDown &&
                        event.eventTime - downTime >= ViewConfiguration.getLongPressTimeout()
                    if (holdDragging) held = minOf(view.selectionStart, view.selectionEnd)..maxOf(view.selectionStart, view.selectionEnd)
                }
                if (!holdDragging) return
                // The word held stays selected: a finger before it moves the start from its end, after it the end from its start.
                val end = if (view.getOffsetForPosition(event.getX(i), event.getY(i)) < held.first) End.START else End.END
                if (end != grabbed) grab(end, event.getX(i), event.getY(i), belowCaret = false, anchorAt = if (end == End.START) held.last else held.first)
                follow(event.getX(i), event.getY(i))
            }
            MotionEvent.ACTION_POINTER_UP -> if (holdDragging && event.getPointerId(event.actionIndex) == pointer) { holdDragging = false; release() }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> if (holdDragging) { holdDragging = false; release() }
        }
    }

    /** Which end of the selection a finger at ([x], [y]) holds: the caret, or the end whose caret is drawn nearer to it. */
    fun nearerEnd(x: Float, y: Float): End {
        if (view.selectionStart == view.selectionEnd) return End.CARET
        val low = minOf(view.selectionStart, view.selectionEnd)
        val high = maxOf(view.selectionStart, view.selectionEnd)
        return if (distanceTo(low, x, y) < distanceTo(high, x, y)) End.START else End.END
    }

    private fun distanceTo(offset: Int, x: Float, y: Float): Float {
        val l = view.layout ?: return Float.MAX_VALUE
        val line = l.getLineForOffset(offset)
        val caretX = view.totalPaddingLeft + l.getPrimaryHorizontal(offset)
        val caretY = view.totalPaddingTop - view.scrollY + l.getLineBottom(line).toFloat()
        return Math.hypot((x - caretX).toDouble(), (y - caretY).toDouble()).toFloat()
    }

    private fun stop() {
        velocity = 0f
        if (!isDriving) return
        isDriving = false
        Choreographer.getInstance().removeFrameCallback(frame)
    }

    private fun step(now: Long) {
        if (!isDriving) return
        if (lastFrame != 0L) {
            val dy = frameStep.scrollPixels(velocity, now - lastFrame)
            val before = view.scrollY
            if (dy != 0) view.scroll.dragBy(dy)
            if (view.scrollY != before) land()
            // At the note's top or end: no frames until the finger asks again.
            else if (dy != 0) { isDriving = false; return }
        }
        lastFrame = now
        Choreographer.getInstance().postFrameCallback(frame)
    }

    /** The dragged end onto the caret stop nearest the finger, the note as it is scrolled now. */
    private fun land() {
        val text = view.editableText ?: return
        val l = view.layout ?: return
        val at = view.getOffsetForPosition(fingerX, landingY())
        if (at < 0 || l.lineCount == 0) return
        if (end == null) return
        // The text changed under the drag (an Undo, a sync): the other end may be gone, and this drag with it.
        if (anchor > text.length) { holdDragging = false; return release() }
        val (from, to) = if (end == End.CARET) at to at else {
            // Never an empty range: on the other end itself, one character as drawn past it the way the note scrolls.
            val moved = when {
                at != anchor -> at
                else -> java.text.BreakIterator.getCharacterInstance().run {
                    setText(text.toString())
                    if (velocity < 0) preceding(anchor) else following(anchor)
                }.takeIf { it != java.text.BreakIterator.DONE } ?: return
            }
            if (end == End.START && moved > anchor || end == End.END && moved < anchor) crossed = true
            minOf(moved, anchor) to maxOf(moved, anchor)
        }
        if (from == view.selectionStart && to == view.selectionEnd) return
        // The scroll put the end there, under the finger: revealing it (a photo's row, taller than the zone) would scroll back.
        view.reveal.hold(from, to)
        Selection.setSelection(text, from, to)
    }

    /** The view y the dragged end lands at: its caret's row under the finger, kept inside the note. */
    private fun landingY(): Float = (fingerY + reach).coerceIn(view.totalPaddingTop.toFloat(), (view.height - view.totalPaddingBottom - 1).toFloat())

    /** Where the [end]'s caret is drawn: half a text line above its row's bottom, a photo's row included. */
    private fun caretRowOf(end: End): Float {
        val l = view.layout ?: return 0f
        val offset = if (end == End.START) minOf(view.selectionStart, view.selectionEnd) else maxOf(view.selectionStart, view.selectionEnd)
        val line = l.getLineForOffset(offset.coerceAtLeast(0))
        return view.totalPaddingTop - view.scrollY + l.getLineBottom(line) - view.lineHeight / 2f
    }
}
