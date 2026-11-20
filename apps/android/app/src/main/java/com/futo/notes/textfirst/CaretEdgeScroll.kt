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
    /** Whether the dragged end is a handle's own slot of the selection (see [grab]). */
    private var slots = false
    /** The range a hold selected before it dragged: its far end stays put whichever way the drag goes. */
    private var held = 0..0
    private var velocity = 0f
    private var running = false
    private var lastFrame = 0L
    private var remainder = 0f
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
     * default where it is now. A handle writes its own slot of the selection (start or end), as the platform's handles
     * read them, even once it has crossed the other; a held drag writes the range in order.
     */
    fun grab(end: End, x: Float, y: Float, belowCaret: Boolean, anchorAt: Int? = null) {
        stop()
        this.end = end
        slots = belowCaret
        reach = if (belowCaret) caretRowOf(end) - y else 0f
        anchor = anchorAt ?: when (end) { End.START -> view.selectionEnd; End.END -> view.selectionStart; End.CARET -> -1 }
        fingerX = x
        fingerY = y
    }

    /** The grabbed end's finger is at ([x], [y]); true while that scrolls the note. */
    fun follow(x: Float, y: Float): Boolean {
        if (end == null) return false
        fingerX = x
        fingerY = y
        velocity = BlockAutoscroll.velocity(y, 0f, view.height.toFloat(), view.style.density)
        if (velocity == 0f) { stop(); return false }
        if (velocity < 0 && view.scrollY == 0 || velocity > 0 && view.scrollY >= view.maxScrollY()) return false
        if (running) return true
        running = true
        lastFrame = 0L
        remainder = 0f
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
                    holdDragging = !view.scroll.dragging && view.selectionStart != view.selectionEnd &&
                        (view.selectionStart to view.selectionEnd) != selectionAtDown &&
                        event.eventTime - downTime >= ViewConfiguration.getLongPressTimeout()
                    if (holdDragging) held = minOf(view.selectionStart, view.selectionEnd)..maxOf(view.selectionStart, view.selectionEnd)
                }
                if (!holdDragging) return
                // The word held stays selected: toward the top its start moves from its end, toward the bottom its end from its start.
                val end = if (event.getY(i) < view.height / 2f) End.START else End.END
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
        if (!running) return
        running = false
        Choreographer.getInstance().removeFrameCallback(frame)
    }

    private fun step(now: Long) {
        if (!running) return
        if (lastFrame != 0L) {
            remainder += BlockAutoscroll.step(velocity, (now - lastFrame) / 1e9f)
            val dy = remainder.toInt()
            remainder -= dy
            val before = view.scrollY
            if (dy != 0) view.scroll.dragBy(dy)
            if (view.scrollY != before) land()
            // At the note's top or end: no frames until the finger asks again.
            else if (dy != 0) { running = false; return }
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
        // The text changed under the drag (an Undo, a sync): the other end may be gone.
        if (anchor > text.length) return release()
        val (from, to) = if (end == End.CARET) at to at else {
            // Never an empty range: on the other end itself, one character (a whole code point) past it the way the note scrolls.
            val moved = when {
                at != anchor -> at
                velocity < 0 && anchor > 0 -> anchor - Character.charCount(Character.codePointBefore(text, anchor))
                velocity > 0 && anchor < text.length -> anchor + Character.charCount(Character.codePointAt(text, anchor))
                else -> return
            }
            when {
                !slots -> minOf(moved, anchor) to maxOf(moved, anchor)
                end == End.START -> moved to anchor
                else -> anchor to moved
            }
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
