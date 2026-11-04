package com.futo.notes.textfirst

import android.view.MotionEvent
import android.view.ViewConfiguration
import kotlin.math.abs

/**
 * A short tap in the margin beside a code block (outside the grey box) selects
 * the whole block as one object. A tap on the code itself still places the
 * caret, which is how code is edited; the fences are hidden, so the margin is
 * the block's frame. Enter then acts after the block, as it does for an image.
 */
internal class CodeBlockTouch(private val view: TextFirstEditText) {
    private val slop = ViewConfiguration.get(view.context).scaledTouchSlop
    private var pressed: Pair<Int, Int>? = null
    private var select: Pair<Int, Int>? = null
    private var downX = 0f
    private var downY = 0f

    /** After the native tap has focused the view and placed its caret, select the block. */
    fun settleSelection() {
        val range = select ?: return
        select = null
        view.selectedObject = range
        view.setSelection(range.first, range.second)
    }

    fun onTouch(event: MotionEvent) {
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                pressed = hit(event.x, event.y)
                downX = event.x
                downY = event.y
            }
            MotionEvent.ACTION_MOVE -> if (abs(event.x - downX) > slop || abs(event.y - downY) > slop) pressed = null
            MotionEvent.ACTION_POINTER_DOWN, MotionEvent.ACTION_CANCEL -> pressed = null
            MotionEvent.ACTION_UP -> {
                val block = pressed
                pressed = null
                if (block != null && event.eventTime - event.downTime < ViewConfiguration.getLongPressTimeout() &&
                    hit(event.x, event.y) == block) {
                    select = block
                }
            }
        }
    }

    /** The code block (its first character to the end of its last line) whose side margin is at this point. */
    private fun hit(x: Float, y: Float): Pair<Int, Int>? {
        if (x >= view.totalPaddingLeft && x < view.width - view.totalPaddingRight) return null
        val layout = view.layout ?: return null
        val text = view.editableText ?: return null
        val localY = y - view.totalPaddingTop + view.scrollY
        if (localY < 0 || localY >= layout.height) return null
        fun code(line: Int): Boolean {
            val start = layout.getLineStart(line)
            return start < text.length && text.getSpans(start, start + 1, TfCodeBlock::class.java)
                .any { text.getSpanStart(it) <= start && start < text.getSpanEnd(it) }
        }
        val tapped = layout.getLineForVertical(localY.toInt())
        if (!code(tapped)) return null
        var first = tapped
        while (first > 0 && code(first - 1)) first--
        var last = tapped
        while (last < layout.lineCount - 1 && code(last + 1)) last++
        // The text's end sentinel is not a caret position.
        var end = minOf(layout.getLineEnd(last), text.length - 1)
        if (end > layout.getLineStart(last) && text[end - 1] == '\n') end--
        return layout.getLineStart(first) to end
    }
}
