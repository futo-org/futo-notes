package com.futo.notes.textfirst

import android.os.SystemClock
import android.view.MotionEvent
import android.view.View
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
import org.junit.Assert.*
import org.junit.Test
import uniffi.futo_notes_ffi.NoteStore

/** Dragging and flinging a long note scrolls it like any Android list; only a tap places the caret. */
class TextFirstScrollGestureTest {
    private fun exercise(check: suspend Rig.() -> Unit) = runBlocking {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val root = File(context.cacheDir, "scroll-gesture-${UUID.randomUUID()}").apply { check(mkdirs()) }
        val scenario = ActivityScenario.launch(ComponentActivity::class.java)
        val store = NoteStore(root.path)
        lateinit var controller: TextFirstController
        try {
            store.createNote("long", "", (1..300).joinToString("\n\n") { "Line number $it of a long note" })
            withContext(Dispatchers.Main) {
                suspendCancellableCoroutine<Unit> { done ->
                    scenario.onActivity { activity ->
                        controller = createTextFirstController(activity, { store }, root)
                        activity.setContentView(controller.view)
                        controller.open("long") { assertNull(it); done.resume(Unit) }
                    }
                }
                val view = controller.view
                view.requestFocus()
                delay(500L)
                Rig(view, controller).check()
            }
        } finally {
            withContext(Dispatchers.Main) { controller.discard(); controller.dispose() }
            scenario.close()
            store.destroy()
            root.deleteRecursively()
        }
    }

    private class Rig(val view: TextFirstEditText, val controller: TextFirstController) {
        val maxScroll get() = view.layout.height + view.totalPaddingTop + view.totalPaddingBottom - view.height

        /** A finger travelling [dy] px (negative = up the screen) in [steps] moves, [stepMs] apart. Returns the scroll at lift. */
        fun swipe(dy: Float, steps: Int, stepMs: Long, x: Float = 100f, startY: Float = view.height * 0.7f): Int {
            val down = SystemClock.uptimeMillis()
            fun send(action: Int, at: Long, y: Float) {
                val e = MotionEvent.obtain(down, at, action, x, y, 0)
                try { view.dispatchTouchEvent(e) } finally { e.recycle() }
            }
            send(MotionEvent.ACTION_DOWN, down, startY)
            for (i in 1..steps) send(MotionEvent.ACTION_MOVE, down + i * stepMs, startY + dy * i / steps)
            send(MotionEvent.ACTION_UP, down + steps * stepMs, startY + dy)
            return view.scrollY
        }
    }

    @Test
    fun aFlickAtTheBottomNeverPlacesTheCaret() = exercise {
        view.scrollTo(0, maxScroll)
        view.setSelection(0)
        val before = view.scrollY
        assertTrue("starts at the bottom ($before of $maxScroll)", before > 1000)
        swipe(dy = -300f, steps = 6, stepMs = 16)
        controller.sourceText()
        assertEquals("a flick that cannot scroll is still not a tap (scroll $before -> ${view.scrollY}, focus ${view.isFocused})", 0, view.selectionStart)
        swipe(dy = 20f, steps = 3, stepMs = 16)
        assertEquals(0, view.selectionStart)
    }

    /** A fast flick can reach the view as a DOWN and an UP far apart, with no MOVE between. */
    @Test
    fun aFlickThatSkipsMoveEventsIsNotATap() = exercise {
        view.scrollTo(0, maxScroll)
        view.setSelection(0)
        swipe(dy = -300f, steps = 0, stepMs = 16)
        controller.sourceText()
        assertEquals(0, view.selectionStart)
        view.scrollTo(0, maxScroll / 2)
        swipe(dy = 300f, steps = 0, stepMs = 16)
        controller.sourceText()
        assertEquals(0, view.selectionStart)
    }

    @Test
    fun aDragInTheMiddleNeverPlacesTheCaret() = exercise {
        view.scrollTo(0, maxScroll / 2)
        view.setSelection(0)
        swipe(dy = -200f, steps = 10, stepMs = 16)
        controller.sourceText()
        assertEquals(0, view.selectionStart)
    }

    @Test
    fun aFlickKeepsScrollingAfterTheFingerLifts() = exercise {
        view.scrollTo(0, 0)
        val atLift = swipe(dy = -400f, steps = 8, stepMs = 16)
        assertTrue("the drag itself scrolled", atLift > 200)
        delay(700L)
        val settled = view.scrollY
        assertTrue("a fast flick coasts well past the drag ($atLift -> $settled)", settled > atLift * 2)
    }

    @Test
    fun aTouchDuringAFlingStopsItWithoutPlacingTheCaret() = exercise {
        view.scrollTo(0, 0)
        view.setSelection(0)
        swipe(dy = -400f, steps = 8, stepMs = 16)
        delay(100L)
        val down = SystemClock.uptimeMillis()
        for ((action, at) in listOf(MotionEvent.ACTION_DOWN to down, MotionEvent.ACTION_UP to down + 30)) {
            val e = MotionEvent.obtain(down, at, action, 100f, view.height * 0.7f, 0)
            try { view.dispatchTouchEvent(e) } finally { e.recycle() }
        }
        val stopped = view.scrollY
        delay(300L)
        assertEquals("the fling stopped", stopped, view.scrollY)
        assertEquals("the stopping touch is not a tap", 0, view.selectionStart)
    }
}
