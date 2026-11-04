package com.futo.notes.textfirst

import androidx.activity.ComponentActivity
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.util.UUID
import kotlin.coroutines.resume
import kotlinx.coroutines.Dispatchers
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
    @Test fun quoteRemainsWhileTheFirstWordIsComposing() = press("text\n", EditorBlockCommand.Quote, composing = true) { it.getSpans(5, 6, TfQuote::class.java).any { span -> it.getSpanStart(span) == 5 && it.getSpanEnd(span) >= 6 } }
    @Test fun headingRemainsWhileTheFirstWordIsComposing() = press("text\n", EditorBlockCommand.Heading(1u), composing = true) { it.getSpans(5, 6, TfHeading::class.java).any { span -> it.getSpanStart(span) == 5 && it.getSpanEnd(span) >= 6 } }
    @Test fun codeRemainsWhileTheFirstWordIsComposing() = press("text\n", EditorBlockCommand.CodeBlock, composing = true) { it.getSpans(5, 6, TfCodeBlock::class.java).any { span -> it.getSpanStart(span) == 5 && it.getSpanEnd(span) >= 6 } }

    @Test fun quoteCompositionDoesNotStyleTheFollowingPlainLine() = withController("> a\n\nplain") { controller ->
        val view = controller.view
        assertTrue(controller.selectDisplayRange(1))
        val connection = view.onCreateInputConnection(android.view.inputmethod.EditorInfo())!!
        ime(view, connection) { setComposingText("bc", 1) }
        assertTrue(view.editableText.getSpans(1, 3, TfQuote::class.java).any { view.editableText.getSpanStart(it) == 0 && view.editableText.getSpanEnd(it) >= 3 })
        ime(view, connection) { commitText("bc", 1) }
        val plain = view.editableText.toString().indexOf("plain")
        assertTrue(controller.selectDisplayRange(plain))
        ime(view, connection) { setComposingText("z", 1) }
        assertEquals("a quote never grows past its terminating newline", 0, view.editableText.getSpans(plain, plain + 1, TfQuote::class.java).size)
    }

    private suspend fun ime(view: TextFirstEditText, connection: android.view.inputmethod.InputConnection, call: android.view.inputmethod.InputConnection.() -> Unit) = suspendCancellableCoroutine<Unit> { done ->
        connection.handler!!.post {
            connection.call()
            view.post { done.resume(Unit) }
        }
    }

    private fun press(raw: String, command: EditorBlockCommand, composing: Boolean = false, shows: (android.text.Spanned) -> Boolean) = withController(raw) { controller ->
        val view = controller.view
        view.requestFocus()
        assertTrue(controller.selectDisplayRange(raw.length))
        controller.block(command)
        controller.sourceText() // Queue barrier: the command and its UI update have completed.
        assertEquals("the caret stays on the empty line", raw.length, view.selectionStart)
        assertTrue("the style shows at the caret before any key is typed", shows(view.editableText))
        if (composing) {
            val connection = view.onCreateInputConnection(android.view.inputmethod.EditorInfo())!!
            for (word in listOf("a", "ab", "a")) {
                ime(view, connection) { setComposingText(word, 1) }
                assertTrue("the block style covers the provisional word '$word' before Space commits it", shows(view.editableText))
            }
            ime(view, connection) { commitText("a ", 1) }
            assertTrue("the committed word keeps its style", shows(view.editableText))
            val committed = controller.sourceText()
            ime(view, connection) { setComposingText("z", 1) }
            val at = view.selectionStart - 1
            assertTrue("the next composing word retains the block margin or face", view.editableText.getSpans(at, at + 1, TfSpan::class.java).any { it is TfQuote || it is TfHeading || it is TfCodeBlock })
            assertEquals("provisional input never writes source", committed, controller.sourceText())
        }
    }

    private fun withController(raw: String, exercise: suspend (TextFirstController) -> Unit) = runBlocking {
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
                exercise(controller)
            }
        } finally {
            withContext(Dispatchers.Main) { controller.discard(); controller.dispose() }
            scenario.close()
            store.destroy()
            root.deleteRecursively()
        }
    }
}
