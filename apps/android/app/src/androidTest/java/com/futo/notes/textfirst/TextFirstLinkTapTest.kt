package com.futo.notes.textfirst

import android.graphics.Color
import android.os.SystemClock
import android.view.MotionEvent
import android.view.ViewGroup
import androidx.activity.ComponentActivity
import androidx.core.content.res.ResourcesCompat
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import com.futo.notes.R
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

/** A tap inside a wrapped wikilink atom puts the caret at the nearest edge of its visual run. */
class TextFirstLinkTapTest {
    private val label = "A very long wikilink label that should wrap across multiple visible lines and remain readable while editing"

    @Test
    fun tapInsideWrappedLinkPlacesCaretAtNearestAtomEdge() = exercise("Before [[$label]] after")

    /** The atom is drawn with the heading's scale, so a tap must be hit-tested against that layout. */
    @Test
    fun tapInsideWrappedLinkInAHeadingPlacesCaretAtNearestAtomEdge() = exercise("# [[$label]] after")

    private fun exercise(source: String) = runBlocking {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val root = File(context.cacheDir, "wikilink-tap-${UUID.randomUUID()}").apply { check(mkdirs()) }
        val scenario = ActivityScenario.launch(ComponentActivity::class.java)
        val width = (320 * context.resources.displayMetrics.density).toInt()
        val store = NoteStore(root.path)
        lateinit var controller: TextFirstController
        try {
            store.createNote("tap", "", source)
            withContext(Dispatchers.Main) {
                suspendCancellableCoroutine<Unit> { done ->
                    scenario.onActivity { activity ->
                        controller = createTextFirstController(activity, { store }, root)
                        activity.setContentView(controller.view, ViewGroup.LayoutParams(width, 2000))
                        controller.open("tap") { assertNull(it); done.resume(Unit) }
                    }
                }
                val view = controller.view
                // Let the window lay the view out at its fixed size. A manual measure/layout raced the window's
                // own first frame, which re-laid the view at another width between the geometry read and the taps.
                withTimeout(10_000) { while (!(view.isLaidOut && view.width == width && view.layout != null)) delay(20) }
                // The atom's caret stops are display offsets; a heading hides its marker, shifting them.
                val link = view.editableText.getSpans(0, view.editableText.length, TfWikilink::class.java).single()
                val start = view.editableText.getSpanStart(link)
                val end = view.editableText.getSpanEnd(link)
                val row = view.layout.getLineForOffset(start)
                val top = view.totalPaddingTop + view.layout.getLineTop(row)
                val tall = view.layout.getLineBottom(row) - view.layout.getLineTop(row)
                assertTrue("label wraps over at least three lines", tall > view.paint.fontSpacing * 3)
                val left = view.totalPaddingLeft + 2f
                val right = width - view.totalPaddingRight - 2f
                suspend fun tap(x: Float, fraction: Float): Int {
                    view.setSelection(0)
                    val down = SystemClock.uptimeMillis()
                    val y = top + tall * fraction
                    for ((action, at) in listOf(MotionEvent.ACTION_DOWN to down, MotionEvent.ACTION_UP to down + 20)) {
                        val e = MotionEvent.obtain(down, at, action, x, y, 0)
                        try { view.dispatchTouchEvent(e) } finally { e.recycle() }
                    }
                    controller.sourceText()
                    return view.selectionStart
                }
                assertEquals("first line, start side", start, tap(left, 0.12f))
                assertEquals("middle line, first third of the run", start, tap(left, 0.5f))
                assertEquals("middle line, past half of the run", end, tap(right, 0.5f))
                assertEquals("last line, start side is past half of the run", end, tap(left, 0.85f))
                assertEquals("last line, end side", end, tap(right, 0.85f))
            }
        } finally {
            withContext(Dispatchers.Main) { controller.discard(); controller.dispose() }
            scenario.close()
            store.destroy()
            root.deleteRecursively()
        }
    }
}
