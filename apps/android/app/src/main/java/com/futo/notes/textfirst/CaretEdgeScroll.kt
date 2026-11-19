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
    private var velocity = 0f
    private var running = false
    private var lastFrame = 0L
    private var remainder = 0f
    private val frame = Choreographer.FrameCallback { now -> step(now) }

    private var downTime = 0L
    private var selectionAtDown = -1 to -1
    private var holdDragging = false

    /** A finger at ([x], [y]), the note's coordinates, carries the selection's [end]; true while it scrolls the note. */
    fun follow(end: End, x: Float, y: Float): Boolean {
        if (this.end != end) reach = caretRowOf(end) - y
        this.end = end
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

    fun release() {
        end = null
        stop()
    }

    /** The note's own touches: a hold that selected and then drags extends its selection, as a handle would. */
    fun onNoteTouch(event: MotionEvent) {
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                downTime = event.downTime
                selectionAtDown = view.selectionStart to view.selectionEnd
                holdDragging = false
            }
            MotionEvent.ACTION_MOVE -> {
                if (!holdDragging) holdDragging = view.selectionStart != view.selectionEnd &&
                    (view.selectionStart to view.selectionEnd) != selectionAtDown &&
                    event.eventTime - downTime >= ViewConfiguration.getLongPressTimeout()
                if (holdDragging) follow(nearerEnd(event.x, event.y), event.x, event.y)
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> if (holdDragging) { holdDragging = false; release() }
        }
    }

    /** Which end of the selection a finger at ([x], [y]) holds: the caret, or the end whose caret is drawn nearer to it. */
    fun nearerEnd(x: Float, y: Float): End {
        if (view.selectionStart == view.selectionEnd) return End.CARET
        return if (distanceTo(view.selectionStart, x, y) < distanceTo(view.selectionEnd, x, y)) End.START else End.END
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
        }
        lastFrame = now
        Choreographer.getInstance().postFrameCallback(frame)
    }

    /** The dragged end onto the caret stop nearest the finger, the note as it is scrolled now. */
    private fun land() {
        val text = view.editableText ?: return
        val l = view.layout ?: return
        val y = (fingerY + reach).coerceIn(view.totalPaddingTop.toFloat(), (view.height - view.totalPaddingBottom - 1).toFloat())
        val at = view.getOffsetForPosition(fingerX, y)
        if (at < 0 || l.lineCount == 0) return
        val start = view.selectionStart
        val selEnd = view.selectionEnd
        val (from, to) = when (end) {
            End.CARET -> at to at
            End.START -> at.coerceAtMost(selEnd - 1) to selEnd
            End.END -> start to at.coerceAtLeast(start + 1)
            null -> return
        }
        if (from == start && to == selEnd) return
        // The scroll put the end there, under the finger: revealing it (a photo's row, taller than the zone) would scroll back.
        view.reveal.hold(from, to)
        Selection.setSelection(text, from, to)
    }

    /** Where the [end]'s caret is drawn: half a text line above its row's bottom, a photo's row included. */
    private fun caretRowOf(end: End): Float {
        val l = view.layout ?: return 0f
        val offset = if (end == End.START) view.selectionStart else view.selectionEnd
        val line = l.getLineForOffset(offset.coerceAtLeast(0))
        return view.totalPaddingTop - view.scrollY + l.getLineBottom(line) - view.lineHeight / 2f
    }
}
