package com.futo.notes.textfirst

import android.view.MotionEvent
import android.view.ViewConfiguration
import kotlin.math.abs

/**
 * A short tap on an image selects it as one object (its two caret stops, start
 * to end). Enter then acts after it, which is how a caret gets past a last
 * image. Scrolling and long-press selection stay native.
 */
internal class ImageTouch(private val view: TextFirstEditText) {
    private val slop = ViewConfiguration.get(view.context).scaledTouchSlop
    private var pressed: TfImage? = null
    private var select: Pair<Int, Int>? = null
    private var downX = 0f
    private var downY = 0f

    /** After the native tap has focused the view and placed its caret, select the image. */
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
                val image = pressed
                pressed = null
                if (image != null && event.eventTime - event.downTime < ViewConfiguration.getLongPressTimeout() &&
                    hit(event.x, event.y) === image) {
                    val text = view.editableText
                    select = text.getSpanStart(image) to text.getSpanEnd(image)
                }
            }
        }
    }

    private fun hit(x: Float, y: Float): TfImage? = view.imageAt(x, y)
}
