package com.futo.notes.textfirst

import android.view.MotionEvent
import android.view.ViewConfiguration
import kotlin.math.abs

/**
 * A short tap on an external link's own glyphs opens it (external-links.md); the blank space past the end of
 * a link's line, a drag and a long press stay ordinary text interaction. Like [WikilinkTouch], the tap is
 * consumed on lift, after the platform has been told the gesture is over, so it places no caret.
 */
internal class ExternalLinkTouch(
    private val view: TextFirstEditText,
    private val open: (String) -> Unit,
    private val cancelNative: (MotionEvent) -> Unit,
) {
    private val slop = ViewConfiguration.get(view.context).scaledTouchSlop
    private var pressed: TfLink? = null
    private var downX = 0f
    private var downY = 0f

    fun onTouch(event: MotionEvent): Boolean {
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                pressed = linkAt(event.x, event.y)
                downX = event.x
                downY = event.y
            }
            MotionEvent.ACTION_MOVE -> if (abs(event.x - downX) > slop || abs(event.y - downY) > slop) pressed = null
            MotionEvent.ACTION_POINTER_DOWN, MotionEvent.ACTION_CANCEL -> pressed = null
            MotionEvent.ACTION_UP -> {
                val link = pressed
                pressed = null
                if (link != null && event.eventTime - event.downTime < ViewConfiguration.getLongPressTimeout() &&
                    linkAt(event.x, event.y) === link) {
                    view.cancelLongPress()
                    view.isPressed = false
                    val cancel = MotionEvent.obtain(event)
                    cancel.action = MotionEvent.ACTION_CANCEL
                    try { cancelNative(cancel) } finally { cancel.recycle() }
                    open(link.destination)
                    return true
                }
            }
        }
        return false
    }

    /** The link whose glyphs on the touched line hold the point. */
    private fun linkAt(x: Float, y: Float): TfLink? {
        val layout = view.layout ?: return null
        val text = view.editableText ?: return null
        val localX = x - view.totalPaddingLeft + view.scrollX
        val localY = y - view.totalPaddingTop + view.scrollY
        if (localY < 0 || localY >= layout.height) return null
        val line = layout.getLineForVertical(localY.toInt())
        val lineStart = layout.getLineStart(line)
        val lineEnd = layout.getLineEnd(line)
        for (link in text.getSpans(lineStart, lineEnd, TfLink::class.java)) {
            val from = maxOf(text.getSpanStart(link), lineStart)
            val to = minOf(text.getSpanEnd(link), lineEnd)
            if (from >= to) continue
            val a = layout.getPrimaryHorizontal(from)
            val b = layout.getPrimaryHorizontal(to)
            if (localX >= minOf(a, b) && localX <= maxOf(a, b)) return link
        }
        return null
    }
}
