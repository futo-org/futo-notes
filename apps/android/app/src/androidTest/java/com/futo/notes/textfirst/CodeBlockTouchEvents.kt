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

/** The header field open beside the note, in the note's parent. */
internal fun openHeaderField(view: TextFirstEditText): android.widget.EditText {
    val host = view.parent as android.view.ViewGroup
    return (0 until host.childCount).map(host::getChildAt).filterIsInstance<android.widget.EditText>().first { it !== view }
}
