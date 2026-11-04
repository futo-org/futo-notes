package com.futo.notes.textfirst

import android.view.MotionEvent
import android.view.ViewConfiguration
import kotlin.math.hypot

/**
 * A third quick tap in one place selects the whole line under the finger. Android's own double-tap picks
 * the word and has no third step, so the first two taps stay the platform's (caret, then word) and this
 * claims only the third, keeping the platform from re-selecting the word over the line.
 */
internal class LineSelectTouch(private val view: TextFirstEditText) {
    private val config = ViewConfiguration.get(view.context)
    private var taps = 0
    private var lastUp = 0L
    private var lastX = 0f
    private var lastY = 0f
    private var downX = 0f
    private var downY = 0f
    private var moved = false
    private var claimed = false

    fun onTouch(event: MotionEvent): Boolean {
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                downX = event.x
                downY = event.y
                moved = false
                claimed = taps >= 2 && continues(event)
            }
            MotionEvent.ACTION_MOVE -> if (far(event.x, event.y, downX, downY, config.scaledTouchSlop)) moved = true
            MotionEvent.ACTION_POINTER_DOWN -> moved = true
            MotionEvent.ACTION_CANCEL -> { claimed = false; taps = 0 }
            MotionEvent.ACTION_UP -> {
                val tap = !moved && !far(event.x, event.y, downX, downY, config.scaledTouchSlop) &&
                    event.eventTime - event.downTime < ViewConfiguration.getLongPressTimeout()
                val third = claimed
                claimed = false
                if (third) {
                    taps = 0
                    if (tap) selectLine(event.x, event.y)
                    return true
                }
                taps = when {
                    !tap -> 0
                    taps > 0 && continues(event) -> taps + 1
                    else -> 1
                }
                lastUp = event.eventTime
                lastX = event.x
                lastY = event.y
            }
        }
        return claimed
    }

    /** This touch begins soon enough after the last tap lifted, and near enough to it, to be its next tap. */
    private fun continues(event: MotionEvent) =
        event.downTime - lastUp <= ViewConfiguration.getDoubleTapTimeout() &&
            !far(downX, downY, lastX, lastY, config.scaledDoubleTapSlop)

    private fun far(x: Float, y: Float, fromX: Float, fromY: Float, limit: Int) = hypot(x - fromX, y - fromY) > limit

    /** The text between the line breaks around the point: a wrapped paragraph is one line. */
    private fun selectLine(x: Float, y: Float) {
        val text = view.editableText ?: return
        // The end sentinel is not a caret position.
        val last = (text.length - 1).coerceAtLeast(0)
        val at = view.getOffsetForPosition(x, y).coerceIn(0, last)
        var start = at
        while (start > 0 && text[start - 1] != '\n') start--
        var end = at
        while (end < last && text[end] != '\n') end++
        view.setSelection(start, end)
    }
}
