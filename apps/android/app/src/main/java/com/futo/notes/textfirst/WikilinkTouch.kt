package com.futo.notes.textfirst

import android.text.style.LeadingMarginSpan
import android.view.MotionEvent
import android.view.ViewConfiguration
import kotlin.math.abs

/** Short taps follow a projected destination; ordinary selection and scrolling stay native. */
internal class WikilinkTouch(private val view: TextFirstEditText, private val open: (String) -> Unit) {
    private val slop = ViewConfiguration.get(view.context).scaledTouchSlop
    private var pressed: TfWikilink? = null
    private var unresolved: Pair<TfWikilink, Float>? = null
    private var settle = -1

    /** After the native tap has focused the view and placed its caret, move the caret to the atom edge. */
    fun settleCaret() {
        val edge = settle
        settle = -1
        if (edge >= 0) view.setSelection(edge)
    }
    private var downX = 0f
    private var downY = 0f

    fun onTouch(event: MotionEvent): Boolean {
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                pressed = hit(event.x, event.y)
                unresolved = locate(event.x, event.y)?.takeIf { it.first.noteId == null }
                downX = event.x
                downY = event.y
            }
            MotionEvent.ACTION_MOVE -> if (abs(event.x - downX) > slop || abs(event.y - downY) > slop) { pressed = null; unresolved = null }
            MotionEvent.ACTION_POINTER_DOWN, MotionEvent.ACTION_CANCEL -> { pressed = null; unresolved = null }
            MotionEvent.ACTION_UP -> {
                val link = pressed
                pressed = null
                val broken = unresolved
                unresolved = null
                if (broken != null && event.eventTime - event.downTime < ViewConfiguration.getLongPressTimeout()) {
                    val text = view.editableText
                    val edge = if (broken.second < 0.5f) text.getSpanStart(broken.first) else text.getSpanEnd(broken.first)
                    settle = edge
                }
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

    private fun hit(x: Float, y: Float): TfWikilink? = locate(x, y)?.takeIf { (link, _) -> link.noteId != null && link.containsAt(view, x, y) }?.first

    /** The link whose visual box holds the point, and where along its wrapped run the point falls (0..1). */
    private fun locate(x: Float, y: Float): Pair<TfWikilink, Float>? {
        val layout = view.layout ?: return null
        val text = view.editableText ?: return null
        val localX = x - view.totalPaddingLeft + view.scrollX
        val localY = y - view.totalPaddingTop + view.scrollY
        if (localY < 0 || localY >= layout.height) return null
        val line = layout.getLineForVertical(localY.toInt())
        for (link in text.getSpans(layout.getLineStart(line), layout.getLineEnd(line), TfWikilink::class.java)) {
            val start = text.getSpanStart(link)
            if (layout.getLineForOffset(start) != line) continue
            var left = layout.getPrimaryHorizontal(start)
            if (layout.isRtlCharAt(start)) left -= link.getSize(link.renderedPaint(view.paint), text, start, text.getSpanEnd(link), null)
            val fraction = link.runFraction(link.renderedPaint(view.paint), localX - left, localY - layout.getLineBaseline(line)) ?: continue
            return link to fraction
        }
        return null
    }
}

private fun TfWikilink.containsAt(view: TextFirstEditText, x: Float, y: Float): Boolean {
    val layout = view.layout ?: return false
    val text = view.editableText ?: return false
    val localY = y - view.totalPaddingTop + view.scrollY
    val line = layout.getLineForVertical(localY.toInt())
    val start = text.getSpanStart(this)
    var left = layout.getPrimaryHorizontal(start)
    if (layout.isRtlCharAt(start)) left -= getSize(renderedPaint(view.paint), text, start, text.getSpanEnd(this), null)
    return contains(renderedPaint(view.paint), x - view.totalPaddingLeft + view.scrollX - left, localY - layout.getLineBaseline(line))
}

/** Reserve only the current paragraph's usable width, including list/quote margins. */
internal fun wikilinkContentWidth(view: TextFirstEditText, span: TfWikilink, width: Int): Int {
    val text = view.editableText
    val start = text.getSpanStart(span).coerceAtLeast(0)
    val margins = text.getSpans(start, start, LeadingMarginSpan::class.java).sumOf { it.getLeadingMargin(true) }
    return maxOf(1, width - margins)
}
