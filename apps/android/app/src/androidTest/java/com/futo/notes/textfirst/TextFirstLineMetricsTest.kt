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
