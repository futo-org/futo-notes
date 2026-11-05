package com.futo.notes.textfirst

import android.os.Handler
import android.os.SystemClock

/** One admitted toolbar action, including its wait for the editor thread. */
internal class ToolbarCommandGate {
    private var pending = false
    private var closing = false

    @Synchronized fun acquire(): Boolean {
        if (closing || pending) return false
        pending = true
        return true
    }

    /** A close may race the post after admission; cancelled work must still decline at dispatch. */
    @Synchronized fun begin(): Boolean = pending && !closing

    @Synchronized fun complete() { pending = false }

    /** Leaving cancels toolbar work that has not started, preserving keyboard input. */
    @Synchronized fun close() { closing = true; pending = false }

    /** A failed save leaves the same draft editable and retryable. */
    @Synchronized fun reopen() { closing = false }
}

/** Handler adapter: cancellation removes only toolbar work, preserving accepted keyboard input. */
internal class ToolbarCommandQueue(
    private val handler: Handler,
    private val execute: (RefusedEdit, () -> Unit) -> Unit,
) {
    private val gate = ToolbarCommandGate()
    private val token = Any()

    fun post(action: RefusedEdit, block: () -> Unit) {
        if (!gate.acquire()) return
        val posted = handler.postAtTime({
            try { if (gate.begin()) execute(action, block) } finally { gate.complete() }
        }, token, SystemClock.uptimeMillis())
        if (!posted) gate.complete()
    }

    fun cancel() {
        gate.close()
        handler.removeCallbacksAndMessages(token)
    }

    fun reopen() = gate.reopen()
}
