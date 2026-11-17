package com.futo.notes.textfirst

import android.os.Build
import android.os.SystemClock
import android.view.MotionEvent

/**
 * A tap on a block's last line hangs the caret's handle over "add a line below", and the handle's
 * own window takes every tap there. The label wins its box (Mason, job13 review; verifier run 3, G),
 * so a handle that would cover it goes. The label shows only once the engine has placed the caret,
 * a frame or more after the tap, so the check runs on the frames that follow the tap.
 */
internal class CodeLineBelowHandle(private val view: TextFirstEditText) {
    private var tappedAt = 0L

    fun onTouch(event: MotionEvent) {
        if (event.actionMasked == MotionEvent.ACTION_UP) tappedAt = event.eventTime
    }

    fun afterDraw() {
        if (tappedAt == 0L || Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return
        if (SystemClock.uptimeMillis() - tappedAt > WATCH_MILLISECONDS) { tappedAt = 0L; return }
        val label = view.codeChrome.belowLabelBox ?: return
        val l = view.layout ?: return
        if (view.selectionStart != view.selectionEnd || view.selectionEnd < 0) return
        val line = l.getLineForOffset(view.selectionEnd)
        val handleBottom = l.getLineBottom(line) + (view.textSelectHandle?.intrinsicHeight ?: return)
        if (label.top >= handleBottom || label.bottom <= l.getLineTop(line)) return
        tappedAt = 0L
        // Turning the caret off drops the insertion handle; turning it back on does not bring it back.
        view.post {
            view.isCursorVisible = false
            view.isCursorVisible = true
        }
    }

    private companion object {
        const val WATCH_MILLISECONDS = 1_000L
    }
}
