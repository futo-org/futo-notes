package com.futo.notes.textfirst

import android.os.SystemClock
import android.view.InputDevice
import android.view.MotionEvent

internal fun tapNoteAt(view: TextFirstEditText, x: Float, y: Float) {
    val down = SystemClock.uptimeMillis()
    for ((action, time) in listOf(MotionEvent.ACTION_DOWN to down, MotionEvent.ACTION_UP to down + 40L)) {
        val event = MotionEvent.obtain(down, time, action, x, y, 0)
        event.source = InputDevice.SOURCE_TOUCHSCREEN
        try { view.dispatchTouchEvent(event) } finally { event.recycle() }
    }
}

internal fun holdNoteAt(view: TextFirstEditText, x: Float, y: Float) {
    val down = SystemClock.uptimeMillis()
    for ((action, time) in listOf(MotionEvent.ACTION_DOWN to down, MotionEvent.ACTION_UP to down + 700L)) {
        val event = MotionEvent.obtain(down, time, action, x, y, 0)
        event.source = InputDevice.SOURCE_TOUCHSCREEN
        try { view.dispatchTouchEvent(event) } finally { event.recycle() }
    }
}
