package com.futo.notes.textfirst

import android.text.style.LeadingMarginSpan
import android.view.MotionEvent
import android.view.ViewConfiguration
import kotlin.math.abs

/** Where a followed wikilink goes: the note it resolves to, or the target no note has yet. */
internal sealed interface WikilinkDestination {
    data class Note(val id: String) : WikilinkDestination
    data class Missing(val target: String) : WikilinkDestination
}

/** Short taps follow a projected destination; ordinary selection and scrolling stay native. */
internal class WikilinkTouch(private val view: TextFirstEditText, private val open: (WikilinkDestination) -> Unit) {
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
                val link = pressed ?: return false
                pressed = null
                if (event.eventTime - event.downTime >= ViewConfiguration.getLongPressTimeout() || hit(event.x, event.y) !== link) return false
                view.cancelLongPress()
                view.isPressed = false
                val noteId = link.noteId
                if (noteId != null) {
                    open(WikilinkDestination.Note(noteId))
                    return true
                }
                val text = view.editableText
                view.engine?.wikilinkTarget(view.appliedSeq, text.getSpanStart(link), text.getSpanEnd(link)) { open(WikilinkDestination.Missing(it)) }
                return true
            }
        }
        return false
    }

    /** The wikilink whose drawn label holds the point, on the visual line the point is on; a missing note's link too. */
    private fun hit(x: Float, y: Float): TfWikilink? {
        val layout = view.layout ?: return null
        val text = view.editableText ?: return null
        val localX = x - view.totalPaddingLeft + view.scrollX
        val localY = y - view.totalPaddingTop + view.scrollY
        if (localY < 0 || localY >= layout.height) return null
        val line = layout.getLineForVertical(localY.toInt())
        return text.getSpans(layout.getLineStart(line), layout.getLineEnd(line), TfWikilink::class.java).firstOrNull { link ->
            val start = text.getSpanStart(link)
            if (layout.getLineForOffset(start) != line) return@firstOrNull false
            val paint = link.renderedPaint(view.paint)
            var left = layout.getPrimaryHorizontal(start)
            if (layout.isRtlCharAt(start)) left -= link.getSize(paint, text, start, text.getSpanEnd(link), null)
            link.contains(paint, localX - left, localY - layout.getLineBaseline(line))
        }
    }
}

/**
 * Reserve only the current paragraph's usable width, including list/quote margins. A list item's text has its hanging
 * margin on every row: on the first, the marker unit takes the rest of it.
 */
internal fun wikilinkContentWidth(view: TextFirstEditText, span: TfWikilink, width: Int): Int {
    val text = view.editableText
    val start = text.getSpanStart(span).coerceAtLeast(0)
    val margins = text.getSpans(start, start, LeadingMarginSpan::class.java).sumOf { it.getLeadingMargin(false) }
    return maxOf(1, width - margins)
}
