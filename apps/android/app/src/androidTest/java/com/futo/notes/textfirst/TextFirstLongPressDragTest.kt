package com.futo.notes.textfirst

import android.os.SystemClock
import android.view.InputDevice
import android.view.MotionEvent
import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Test

/** Area 3 verifier, 3.1: a long-press selects a word, and dragging on without lifting extends the selection, as on !300. */
class TextFirstLongPressDragTest {
    @Test fun aLongPressThenADragExtendsTheSelection() = textFirstSession("A paragraph long enough to wrap onto a second row on a phone.\n\nafter") { c ->
        val view = c.view
        view.isFocusableInTouchMode = true
        view.requestFocus()
        withTimeout(5_000) { while (view.layout == null) delay(20) }
        val l = view.layout
        val word = view.editableText.indexOf("paragraph")
        val y = view.totalPaddingTop + (l.getLineTop(0) + l.getLineBottom(0)) / 2f
        val fromX = view.totalPaddingLeft + l.getPrimaryHorizontal(word + 3)
        val toX = view.totalPaddingLeft + l.getPrimaryHorizontal(view.editableText.indexOf("wrap") + 2)
        val down = SystemClock.uptimeMillis()
        fun send(action: Int, x: Float) {
            val event = MotionEvent.obtain(down, SystemClock.uptimeMillis(), action, x, y, 0)
            event.source = InputDevice.SOURCE_TOUCHSCREEN
            try { view.dispatchTouchEvent(event) } finally { event.recycle() }
        }
        send(MotionEvent.ACTION_DOWN, fromX)
        delay(android.view.ViewConfiguration.getLongPressTimeout() + 300L)
        assertEquals("the long-press did not select the word", "paragraph", view.editableText.substring(view.selectionStart, view.selectionEnd))
        for (step in 1..10) {
            send(MotionEvent.ACTION_MOVE, fromX + (toX - fromX) * step / 10f)
            delay(32)
        }
        send(MotionEvent.ACTION_UP, toX)
        delay(300)
        val selected = view.editableText.substring(view.selectionStart, view.selectionEnd)
        assert(selected.startsWith("paragraph long enough to w")) { "the drag did not extend the selection: \"$selected\"" }
    }
}
