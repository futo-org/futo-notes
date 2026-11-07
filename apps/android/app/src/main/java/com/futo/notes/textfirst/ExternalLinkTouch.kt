package com.futo.notes.textfirst

import android.graphics.Path
import android.graphics.Region
import android.view.MotionEvent
import android.view.ViewConfiguration
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.floor

/**
 * A short tap on an external link's own glyphs opens it (external-links.md); the blank space past the end of
 * a link's line, a drag and a long press stay ordinary text interaction. Like [WikilinkTouch], the tap is
 * consumed on lift, after the platform has been told the gesture is over, so it places no caret. A link the
 * system cannot open ([open] answers false) is no link tap: the lift stays ordinary text interaction.
 */
internal class ExternalLinkTouch(
    private val view: TextFirstEditText,
    private val open: (String) -> Boolean,
    private val cancelNative: (MotionEvent) -> Unit,
) {
    private val slop = ViewConfiguration.get(view.context).scaledTouchSlop
    private val glyphPath = Path()
    private val glyphRegion = Region()
    private val lineRegion = Region()
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
                    linkAt(event.x, event.y) === link && open(link.destination)) {
                    view.cancelLongPress()
                    view.isPressed = false
                    val cancel = MotionEvent.obtain(event)
                    cancel.action = MotionEvent.ACTION_CANCEL
                    try { cancelNative(cancel) } finally { cancel.recycle() }
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
        val lineEnd = layout.getLineVisibleEnd(line)
        val left = layout.getLineLeft(line)
        val right = layout.getLineRight(line)
        if (localX < left || localX > right) return null
        lineRegion.set(floor(left).toInt(), layout.getLineTop(line), ceil(right).toInt(), layout.getLineBottom(line))
        for (link in text.getSpans(lineStart, lineEnd, TfLink::class.java)) {
            val from = maxOf(text.getSpanStart(link), lineStart)
            val to = minOf(text.getSpanEnd(link), lineEnd)
            if (from >= to) continue
            // Layout resolves wrapped endpoints and bidi runs in their actual line. Its selection
            // path can also fill a line's blank tail, so clip it to that line's visible extent.
            glyphPath.reset()
            layout.getSelectionPath(from, to, glyphPath)
            glyphRegion.setPath(glyphPath, lineRegion)
            if (glyphRegion.contains(floor(localX).toInt(), floor(localY).toInt())) return link
        }
        return null
    }
}
