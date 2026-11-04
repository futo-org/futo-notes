package com.futo.notes.textfirst

import android.view.MotionEvent
import android.view.ViewConfiguration
import kotlin.math.abs

/**
 * A short tap on the handle at a code block's top-right corner selects the
 * whole block as one object. A tap on the code itself still places the caret,
 * which is how code is edited; the fences are hidden, so the handle is the
 * block's frame. Enter then acts after the block, as it does for an image.
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

    /** The code block (its first character to the end of its last line) whose corner handle is at this point. */
    private fun hit(x: Float, y: Float): Pair<Int, Int>? {
        val layout = view.layout ?: return null
        val text = view.editableText ?: return null
        val localX = x - view.totalPaddingLeft + view.scrollX
        val localY = y - view.totalPaddingTop + view.scrollY
        if (localY < 0 || localY >= layout.height) return null
        val line = layout.getLineForVertical(localY.toInt())
        // The target reaches a little above the box, so the line before may be the one hit.
        val first = (line..minOf(line + 1, layout.lineCount - 1)).firstOrNull { cand ->
            view.isCodeLine(cand) && (cand == 0 || !view.isCodeLine(cand - 1)) &&
                view.codeHandleTarget(cand).contains(localX, localY)
        } ?: return null
        var last = first
        while (last < layout.lineCount - 1 && view.isCodeLine(last + 1)) last++
        // The text's end sentinel is not a caret position.
        var end = minOf(layout.getLineEnd(last), text.length - 1)
        if (end > layout.getLineStart(last) && text[end - 1] == '\n') end--
        return layout.getLineStart(first) to end
    }
}
