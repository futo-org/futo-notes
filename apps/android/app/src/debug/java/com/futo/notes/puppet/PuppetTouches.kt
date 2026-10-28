package com.futo.notes.puppet

import android.app.Activity
import android.content.ContextWrapper
import android.view.MotionEvent
import android.view.View
import android.view.Window
import org.json.JSONArray
import org.json.JSONObject

/**
 * The touches the app's own window received, so `futo-puppet` can tell a tap the app never got
 * from one it got and ignored: `adb shell input` exits 0 wherever the touch lands. Recorded
 * as each touch goes down, where the activity's window dispatches it, by wrapping the
 * window's callback. A dialog or menu is a window with its own callback, which this does not
 * see, so a read says when one is up (`covered`) and the CLI does not claim a miss then. The
 * listener's `touches` query; debug builds only. Main thread only.
 */
internal object PuppetTouches {
    private const val KEPT = 64
    private val received = ArrayDeque<JSONObject>()
    private var last = 0

    /** Idempotent: a read installs it again should anything have replaced the callback. */
    fun install(view: View) {
        val activity = generateSequence(view.context) { (it as? ContextWrapper)?.baseContext }
            .filterIsInstance<Activity>().firstOrNull() ?: return
        val callback = activity.window.callback
        if (callback !is Recorder) activity.window.callback = Recorder(callback)
    }

    /** `touches {"since"?}`: how many so far as `last`, and those after `since`, in device pixels. */
    fun since(cursor: Int?, covered: Boolean): JSONObject = JSONObject()
        .put("last", last)
        .put("touches", JSONArray(received.filter { it.getInt("id") > (cursor ?: last) }))
        .put("covered", covered)

    private fun record(event: MotionEvent) {
        last += 1
        received.addLast(JSONObject().put("id", last).put("x", event.rawX.toInt()).put("y", event.rawY.toInt()))
        while (received.size > KEPT) received.removeFirst()
    }

    private class Recorder(private val wrapped: Window.Callback) : Window.Callback by wrapped {
        override fun dispatchTouchEvent(event: MotionEvent): Boolean {
            if (event.actionMasked == MotionEvent.ACTION_DOWN) record(event)
            return wrapped.dispatchTouchEvent(event)
        }
    }
}
