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
import uniffi.futo_notes_ffi.EditorBlockCommand
import uniffi.futo_notes_ffi.NoteStore

/** A block-style button shows its style on an empty line at once, wherever that line is. */
class TextFirstBlockIndicatorTest {
    @Test fun headingOnTheLastEmptyLineAfterText() = press("text\n", EditorBlockCommand.Heading(1u)) { it.getSpans(5, 5, TfHeading::class.java).any { h -> h.level == 1 } }
    @Test fun headingAfterSeveralBlankLines() = press("text\n\n\n", EditorBlockCommand.Heading(1u)) { it.getSpans(7, 7, TfHeading::class.java).any { h -> h.level == 1 } }
    @Test fun quoteOnTheLastEmptyLineAfterText() = press("text\n", EditorBlockCommand.Quote) { it.getSpans(5, 5, TfQuote::class.java).isNotEmpty() }
    @Test fun codeBlockOnTheLastEmptyLineAfterText() = press("text\n", EditorBlockCommand.CodeBlock) { it.getSpans(5, 5, TfCodeBlock::class.java).isNotEmpty() }

    private fun press(raw: String, command: EditorBlockCommand, shows: (android.text.Spanned) -> Boolean) = runBlocking {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val root = File(context.cacheDir, "block-indicator-${UUID.randomUUID()}").apply { check(mkdirs()) }
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
                controller.select(raw.length)
                delay(300L)
                controller.block(command)
                delay(500L)
                assertEquals("the caret stays on the empty line", raw.length, view.selectionStart)
                assertTrue("the style shows at the caret before any key is typed", shows(view.editableText))
            }
        } finally {
            withContext(Dispatchers.Main) { controller.discard(); controller.dispose() }
            scenario.close()
            store.destroy()
            root.deleteRecursively()
        }
    }
}
