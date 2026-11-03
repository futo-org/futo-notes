package com.futo.notes.textfirst

import android.text.style.LeadingMarginSpan
import android.view.MotionEvent
import android.view.ViewConfiguration
import kotlin.math.abs

/** Short taps follow a projected destination; ordinary selection and scrolling stay native. */
internal class WikilinkTouch(private val view: TextFirstEditText, private val open: (String) -> Unit) {
    private val slop = ViewConfiguration.get(view.context).scaledTouchSlop
    private var pressed: TfWikilink? = null
    private var downX = 0f
    private var downY = 0f

    fun onTouch(event: MotionEvent): Boolean {
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                pressed = hit(event.x, event.y)
                downX = event.x
                downY = event.y
            }
            MotionEvent.ACTION_MOVE -> if (abs(event.x - downX) > slop || abs(event.y - downY) > slop) pressed = null
            MotionEvent.ACTION_POINTER_DOWN, MotionEvent.ACTION_CANCEL -> pressed = null
            MotionEvent.ACTION_UP -> {
                val link = pressed
                pressed = null
                if (link != null && event.eventTime - event.downTime < ViewConfiguration.getLongPressTimeout() &&
                    hit(event.x, event.y) === link) {
                    view.cancelLongPress()
                    view.isPressed = false
                    link.noteId?.let(open)
                    return true
                }
            }
        }
        return false
    }

    private fun hit(x: Float, y: Float): TfWikilink? {
        val layout = view.layout ?: return null
        val text = view.editableText ?: return null
        val localX = x - view.totalPaddingLeft + view.scrollX
        val localY = y - view.totalPaddingTop + view.scrollY
        if (localY < 0 || localY >= layout.height) return null
        val line = layout.getLineForVertical(localY.toInt())
        for (link in text.getSpans(layout.getLineStart(line), layout.getLineEnd(line), TfWikilink::class.java)) {
            if (link.noteId == null) continue
            val start = text.getSpanStart(link)
            if (layout.getLineForOffset(start) != line) continue
            var left = layout.getPrimaryHorizontal(start)
            if (layout.isRtlCharAt(start)) left -= link.getSize(view.paint, text, start, text.getSpanEnd(link), null)
            if (link.contains(view.paint, localX - left, localY - layout.getLineBaseline(line))) return link
        }
        return null
    }
}

/** Reserve only the current paragraph's usable width, including list/quote margins. */
internal fun wikilinkContentWidth(view: TextFirstEditText, span: TfWikilink, width: Int): Int {
    val text = view.editableText
    val start = text.getSpanStart(span).coerceAtLeast(0)
    val margins = text.getSpans(start, start, LeadingMarginSpan::class.java).sumOf { it.getLeadingMargin(true) }
    return maxOf(1, width - margins)
}
