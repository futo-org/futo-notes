package com.futo.notes.textfirst

import android.text.style.ReplacementSpan
import android.view.MotionEvent
import android.view.ViewConfiguration
import kotlin.math.abs

/**
 * A short tap on an image or a divider selects it as one object (its two caret stops, start
 * to end). Enter then acts after it, which is how a caret gets past a last
 * image. Scrolling and long-press selection stay native. A divider taken by a tap is desktop's rule.
 */
internal class ImageTouch(private val view: TextFirstEditText) {
    private val slop = ViewConfiguration.get(view.context).scaledTouchSlop
    private var pressed: ReplacementSpan? = null
    private var select: Pair<Int, Int>? = null
    private var downX = 0f
    private var downY = 0f

    /** After the native tap has focused the view and placed its caret, select the image. */
    fun settleSelection() {
        val range = select ?: return
        select = null
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

    /**
     * A long-press on an image (or a divider) selects it as one object too, never the platform's word selection, which
     * took the line break after an image that ends its line. The lift that ends the press settles the same selection.
     */
    fun longPress(): Boolean {
        val atom = pressed ?: return false
        pressed = null
        val text = view.editableText
        val range = text.getSpanStart(atom) to text.getSpanEnd(atom)
        if (range.first < 0) return false
        select = range
        view.setSelection(range.first, range.second)
        return true
    }

    private fun hit(x: Float, y: Float): ReplacementSpan? {
        val layout = view.layout ?: return null
        val text = view.editableText ?: return null
        val localX = x - view.totalPaddingLeft + view.scrollX
        val localY = y - view.totalPaddingTop + view.scrollY
        if (localY < 0 || localY >= layout.height) return null
        val line = layout.getLineForVertical(localY.toInt())
        for (atom in text.getSpans(layout.getLineStart(line), layout.getLineEnd(line), ReplacementSpan::class.java)) {
            if (atom !is TfImage && atom !is TfDivider) continue
            val start = text.getSpanStart(atom)
            if (layout.getLineForOffset(start) != line) continue
            val left = layout.getPrimaryHorizontal(start)
            val width = atom.getSize(view.paint, text, start, text.getSpanEnd(atom), null)
            if (localX >= left && localX < left + width) return atom
        }
        return null
    }
}
