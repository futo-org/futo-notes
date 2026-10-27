package com.futo.notes.ui

import android.content.Context
import android.os.Build
import android.widget.Toast

/**
 * The app's one toast slot, as on desktop and iOS: a new toast cancels the one on
 * screen. [message] is what the app last handed the OS, recorded as `copied` and
 * `opened` are, until the OS reports that toast hidden. A cancelled toast reports
 * hidden after its successor is up, so only the latest one's report counts. A
 * toast the OS drops (sent from the background) never reports, and its text
 * stays until the next toast. Generic over the toast so the rule runs in a JVM test.
 */
internal class ToastSlot<T : Any>(private val cancel: (T) -> Unit) {
    private var latest: Pair<T, String>? = null

    /** The message on screen, "" when none. */
    val message: String get() = latest?.second.orEmpty()

    fun show(toast: T, text: String) {
        latest?.first?.let(cancel)
        latest = toast to text
    }

    fun hidden(toast: T) {
        if (latest?.first === toast) latest = null
    }
}

private val slot = ToastSlot<Toast> { it.cancel() }

/** The toast on screen, "" when none (always "" below API 30): puppet's `state.toast`. */
val currentToast: String get() = slot.message

/**
 * Every toast the app shows goes through here, on the main thread, with the
 * caller's context. The slot holds the toast until the OS reports it hidden (API
 * 30+) or the next one shows, which below API 30 can be long after the screen
 * that showed it has closed, so the toast is made from the app's context, not
 * the screen's: on the screen's display, where the OS can name it (API 30+).
 */
fun showToast(context: Context, text: String, long: Boolean = false) {
    val duration = if (long) Toast.LENGTH_LONG else Toast.LENGTH_SHORT
    val toast = Toast.makeText(appContextOnDisplayOf(context), text, duration)
    // Before API 30 the OS never reports a toast hidden, so nothing is recorded there.
    val reportsHidden = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R
    if (reportsHidden) {
        toast.addCallback(
            object : Toast.Callback() {
                override fun onToastHidden() = slot.hidden(toast)
            },
        )
    }
    slot.show(toast, if (reportsHidden) text else "")
    toast.show()
}

/** The app's context, on [context]'s display when it has one. */
private fun appContextOnDisplayOf(context: Context): Context {
    val app = context.applicationContext
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return app
    // A context with no display of its own (the app's, a service's) throws here.
    val display = runCatching { context.display }.getOrNull() ?: return app
    return app.createDisplayContext(display)
}
