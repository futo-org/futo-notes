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

/** A tap anywhere along a wrapped wikilink to a missing note follows it, hit-tested against the link's own layout. */
class TextFirstLinkTapTest {
    private val label = "A very long wikilink label that should wrap across multiple visible lines and remain readable while editing"

    @Test
    fun tapAnywhereOnAWrappedLinkFollowsIt() = exercise("Before [[$label]] after")

    /** The atom is drawn with the heading's scale, so a tap must be hit-tested against that layout. */
    @Test
    fun tapAnywhereOnAWrappedLinkInAHeadingFollowsIt() = exercise("# [[$label]] after")

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
                val row = view.layout.getLineForOffset(start)
                val top = view.totalPaddingTop + view.layout.getLineTop(row)
                val tall = view.layout.getLineBottom(row) - view.layout.getLineTop(row)
                assertTrue("label wraps over at least three lines", tall > view.paint.fontSpacing * 3)
                val left = view.totalPaddingLeft + 2f
                val right = width - view.totalPaddingRight - 2f
                val followed = mutableListOf<WikilinkDestination>()
                view.onOpenWikilink = { followed.add(it) }
                fun tap(x: Float, fraction: Float) {
                    val down = SystemClock.uptimeMillis()
                    val y = top + tall * fraction
                    for ((action, at) in listOf(MotionEvent.ACTION_DOWN to down, MotionEvent.ACTION_UP to down + 20)) {
                        val e = MotionEvent.obtain(down, at, action, x, y, 0)
                        try { view.dispatchTouchEvent(e) } finally { e.recycle() }
                    }
                }
                tap(left, 0.12f)
                tap(left, 0.5f)
                tap(right, 0.5f)
                tap(left, 0.85f)
                tap(right, 0.85f)
                withTimeout(5_000) { while (followed.size < 5) delay(20) }
                assertEquals("every visual line of the link follows it", List(5) { WikilinkDestination.Missing(label) }, followed)
            }
        } finally {
            withContext(Dispatchers.Main) { controller.discard(); controller.dispose() }
            scenario.close()
            store.destroy()
            root.deleteRecursively()
        }
    }
}
