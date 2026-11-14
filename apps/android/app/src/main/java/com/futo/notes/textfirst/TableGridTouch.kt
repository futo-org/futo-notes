package com.futo.notes.textfirst

import android.view.MotionEvent
import android.view.ViewConfiguration
import kotlin.math.abs

/** Native grid gestures: tap one cell, scroll columns together, or scroll through the note vertically. */
internal class TableGridTouch(
    private val view: TextFirstEditText,
    private val edit: (GridCell) -> Unit,
    private val redraw: (TableScroll) -> Unit,
) {
    private var down: TfTableRow? = null
    private var x = 0f
    private var y = 0f
    private var moved = false
    private var vertical = false

    fun onTouch(event: MotionEvent): Boolean {
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                down = view.tableRowAt(event.y)
                if (down == null) return false
                x = event.x; y = event.y; moved = false; vertical = false
                view.parent?.requestDisallowInterceptTouchEvent(true)
                return true
            }
            MotionEvent.ACTION_UP -> {
                val row = down ?: return false
                if (!moved) view.tableCellAt(row, event.x)?.let { cell ->
                    edit(cell)
                }
                down = null
                if (moved && vertical) view.scroll.release()
                view.parent?.requestDisallowInterceptTouchEvent(false)
                return true
            }
            MotionEvent.ACTION_MOVE -> {
                val row = down ?: return false
                val dx = x - event.x
                val dy = y - event.y
                val slop = ViewConfiguration.get(view.context).scaledTouchSlop
                if (abs(dx) > slop || abs(dy) > slop || moved) {
                    if (!moved) vertical = abs(dy) > abs(dx)
                    moved = true
                    if (vertical) {
                        view.scroll.dragBy(dy.toInt())
                        y = event.y
                    } else {
                        row.scrollBy(dx); x = event.x
                        redraw(row.scroll)
                    }
                }
                return true
            }
            MotionEvent.ACTION_CANCEL -> {
                if (down == null) return false
                down = null
                view.parent?.requestDisallowInterceptTouchEvent(false)
                return true
            }
        }
        return false
    }

}
