package com.futo.notes.textfirst

import android.os.SystemClock
import android.view.ActionMode
import android.view.Menu
import android.view.MenuItem
import android.view.InputDevice
import android.view.MotionEvent
import android.view.ViewGroup
import androidx.activity.ComponentActivity
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.util.UUID
import kotlin.coroutines.resume
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.junit.Assert.*
import org.junit.Test
import uniffi.futo_notes_ffi.NoteStore

/** The tap gesture tests' note: a word line, two bare links and a labelled link. */
internal const val TAP_GESTURE_NOTE = "alpha beta gamma\n\nsee https://example.com now and www.example.org too\n\n[label](https://label.example) end"

/** Open [source] in a real note view 360 dp wide, focused, and run [check] on it. */
internal fun tapGestureSession(source: String, check: suspend TapGestureRig.() -> Unit) = runBlocking {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    val root = File(context.cacheDir, "tap-gesture-${UUID.randomUUID()}").apply { check(mkdirs()) }
    val scenario = ActivityScenario.launch(ComponentActivity::class.java)
    val width = (360 * context.resources.displayMetrics.density).toInt()
    val store = NoteStore(root.path)
    lateinit var controller: TextFirstController
    try {
        store.createNote("taps", "", source)
        withContext(Dispatchers.Main) {
            suspendCancellableCoroutine<Unit> { done ->
                scenario.onActivity { activity ->
                    controller = createTextFirstController(activity, { store }, root)
                    activity.setContentView(controller.view, ViewGroup.LayoutParams(width, 1600))
                    controller.open("taps") { assertNull(it); done.resume(Unit) }
                }
            }
            val view = controller.view
            withTimeout(10_000) { while (!(view.isLaidOut && view.width == width && view.layout != null)) delay(20) }
            // The bare test activity has no AppCompat theme, so the EditText style that makes it focusable is absent.
            view.isFocusableInTouchMode = true
            view.requestFocus()
            delay(300L)
            TapGestureRig(view, controller).check()
        }
    } finally {
        withContext(Dispatchers.Main) { controller.discard(); controller.dispose() }
        scenario.close()
        store.destroy()
        root.deleteRecursively()
    }
}

internal class TapGestureRig(val view: TextFirstEditText, val controller: TextFirstController) {
    val text get() = view.editableText.toString()

    /** The point in the middle of [needle]'s [index]th character. */
    fun pointAt(needle: String, index: Int = needle.length / 2): Pair<Float, Float> {
        val offset = text.indexOf(needle).also { check(it >= 0) { "'$needle' not in '$text'" } } + index
        val layout = view.layout
        val line = layout.getLineForOffset(offset)
        val x = (layout.getPrimaryHorizontal(offset) + layout.getPrimaryHorizontal(offset + 1)) / 2
        val y = (layout.getLineTop(line) + layout.getLineBottom(line)) / 2f
        return view.totalPaddingLeft + x to view.totalPaddingTop + y
    }

    /** The gesture clock: events carry their own times, so a stalled main thread cannot stretch a double-tap. */
    private var clock = SystemClock.uptimeMillis()

    /** [count] quick taps at one point, 100 ms apart by their own timestamps; returns when the last one is up. */
    suspend fun taps(
        point: Pair<Float, Float>,
        count: Int,
        drift: FloatArray = floatArrayOf(),
        duration: Long = 40L,
        afterDown: (tap: Int) -> Unit = {},
    ) {
        clock = maxOf(clock + 1_000L, SystemClock.uptimeMillis())
        repeat(count) {
            val down = clock
            val path = listOf(MotionEvent.ACTION_DOWN to 0f) + drift.dropLast(1).map { MotionEvent.ACTION_MOVE to it } +
                (MotionEvent.ACTION_UP to (drift.lastOrNull() ?: 0f))
            path.forEachIndexed { step, (action, dx) ->
                val e = MotionEvent.obtain(down, down + duration * step / path.lastIndex, action, point.first + dx, point.second, 0)
                e.source = InputDevice.SOURCE_TOUCHSCREEN
                try { view.dispatchTouchEvent(e) } finally { e.recycle() }
                if (action == MotionEvent.ACTION_DOWN) afterDown(it)
            }
            clock += 100L
        }
        controller.sourceText()
    }

    fun selected() = text.substring(view.selectionStart, view.selectionEnd)
}
