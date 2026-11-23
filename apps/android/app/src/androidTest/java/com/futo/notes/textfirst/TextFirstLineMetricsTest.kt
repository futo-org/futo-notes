package com.futo.notes.textfirst

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

/** Line heights of the rendered editor: a line's height must not depend on whether it has text yet. */
class TextFirstLineMetricsTest {
    @Test fun emptyHeadingLineIsAsTallAsOneWithText() {
        for (marker in listOf("#", "##", "###")) {
            // Same position in both notes: the heading is the second line, with a body line either side.
            val empty = lineHeights("x\n$marker \ny\n")
            val filled = lineHeights("x\n$marker H\ny\n")
            assertEquals("an empty $marker line keeps the height it has with text", filled[1], empty[1])
        }
    }

    /** The delimiter line takes no height: the first body row's top is the header row's bottom. */
    @Test fun tableHeaderAndBodyRowsMeet() {
        val heights = lineHeights("| a | b |\n|---|---|\n| c | d |\nz\n")
        assertEquals("the delimiter line between header and body ($heights)", 0, heights[1])
    }

    /**
     * An h1 or h2 row is 1.25 times its font size and an h3 to h6 row one body line, with tall and deep glyphs in it,
     * with inline code and bold mixed in, and with nothing added above or below the heading.
     */
    @Test fun headingLinesKeepTheBodyLineGrid() {
        val heights = lineHeights("x\ny\n# Ågjpq\n## Ågjpq\n### Ågjpq\n#### Ågjpq\n##### Ågjpq\n###### Ågjpq\n# Ågjpq `code` **b**\n### Ågjpq `code` **b**\nz\n")
        val body = heights[1]
        val size = 17f * InstrumentationRegistry.getInstrumentation().targetContext.resources.displayMetrics.scaledDensity
        val h1 = kotlin.math.round(1.25f * 1.5f * size).toInt()
        assertEquals("an h1 row is 1.25 times its font ($heights)", h1, heights[2])
        assertEquals("an h2 row is 1.25 times its font ($heights)", kotlin.math.round(1.25f * 1.375f * size).toInt(), heights[3])
        for (line in 4..7) assertEquals("a level ${line - 1} heading row is one body line ($heights)", body, heights[line])
        assertEquals("an h1 row mixing code and bold keeps its height ($heights)", h1, heights[8])
        assertEquals("an h3 row mixing code and bold keeps its height ($heights)", body, heights[9])
    }

    /** A fallback font (Arabic, Hebrew) must not make its row taller than a Latin row of the same list. */
    @Test fun rightToLeftListItemIsAsTallAsALatinOne() {
        val heights = lineHeights("- one\n- two\n- العربية\n- three\n- עברית\n- four\n")
        assertEquals("the Arabic row keeps the Latin row height ($heights)", heights[1], heights[2])
        assertEquals("the Hebrew row keeps the Latin row height ($heights)", heights[1], heights[4])
    }

    /** TextView clips its text to the padding box while scrolled: the bottom padding must not hide lines behind it. */
    @Test fun scrolledTextIsNotClippedAtTheBottomPadding() = runBlocking {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val root = File(context.cacheDir, "line-metrics-${UUID.randomUUID()}").apply { check(mkdirs()) }
        val scenario = ActivityScenario.launch(ComponentActivity::class.java)
        val store = NoteStore(root.path)
        lateinit var controller: TextFirstController
        try {
            store.createNote("n", "", (1..80).joinToString("\n") { "line $it" })
            withContext(Dispatchers.Main) {
                suspendCancellableCoroutine<Unit> { done ->
                    scenario.onActivity { activity ->
                        controller = createTextFirstController(activity, { store }, root)
                        activity.setContentView(controller.view)
                        controller.open("n") { assertNull(it); done.resume(Unit) }
                    }
                }
                val view = controller.view
                delay(500L)
                val layout = view.layout
                val band = view.paddingBottom
                assertTrue("the view has a bottom padding to test", band > 0)
                // Put the middle of a line in the middle of the bottom padding band.
                val line = layout.lineCount / 2
                val center = (layout.getLineTop(line) + layout.getLineBottom(line)) / 2 + view.totalPaddingTop
                val scroll = center - (view.height - band / 2)
                view.scrollTo(0, scroll)
                delay(300L)
                assertEquals(scroll, view.scrollY)
                val bitmap = android.graphics.Bitmap.createBitmap(view.rootView.width, view.rootView.height, android.graphics.Bitmap.Config.ARGB_8888)
                view.rootView.draw(android.graphics.Canvas(bitmap))
                val at = IntArray(2).also { view.getLocationInWindow(it) }
                var dark = 0
                for (y in (at[1] + view.height - band) until (at[1] + view.height)) {
                    for (x in 0 until bitmap.width) {
                        val c = bitmap.getPixel(x, y)
                        if (android.graphics.Color.red(c) < 100 && android.graphics.Color.green(c) < 100) dark++
                    }
                }
                assertTrue("text scrolled into the bottom padding band still shows (dark pixels: $dark)", dark > 20)
            }
        } finally {
            withContext(Dispatchers.Main) { controller.discard(); controller.dispose() }
            scenario.close()
            store.destroy()
            root.deleteRecursively()
        }
    }

    private fun lineHeights(raw: String): List<Int> = runBlocking {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val root = File(context.cacheDir, "line-metrics-${UUID.randomUUID()}").apply { check(mkdirs()) }
        val scenario = ActivityScenario.launch(ComponentActivity::class.java)
        val store = NoteStore(root.path)
        lateinit var controller: TextFirstController
        try {
            store.createNote("n", "", raw)
            withContext(Dispatchers.Main) {
                suspendCancellableCoroutine<Unit> { done ->
                    scenario.onActivity { activity ->
                        controller = createTextFirstController(activity, { store }, root)
                        activity.setContentView(controller.view)
                        controller.open("n") { assertNull(it); done.resume(Unit) }
                    }
                }
                val view = controller.view
                view.requestFocus()
                // The caret on the last line, away from the heading under test.
                controller.select(raw.length)
                delay(500L)
                val layout = view.layout
                (0 until layout.lineCount).map { layout.getLineBottom(it) - layout.getLineTop(it) }
            }
        } finally {
            withContext(Dispatchers.Main) { controller.discard(); controller.dispose() }
            scenario.close()
            store.destroy()
            root.deleteRecursively()
        }
    }
}
