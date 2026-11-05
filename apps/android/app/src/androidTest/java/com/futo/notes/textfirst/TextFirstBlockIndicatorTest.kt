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
import uniffi.futo_notes_ffi.EditorInlineFormat
import uniffi.futo_notes_ffi.NoteStore

/**
 * A style shows at once: a block-style button on an empty line wherever that line is,
 * and composing (marked) text in the formats it will have once committed.
 */
class TextFirstBlockIndicatorTest {
    @Test fun selectAllCodeBlockKeepsMixedNoteTextAndUndoesInOneStep() = withController(
        "# heading\n\n**bold** and *italic*\n\n- item\n\n```\ncode\n```\n\n| a | b |\n| --- | --- |\n| c | d |\n",
    ) { controller ->
        val view = controller.view
        val original = controller.sourceText()
        val display = view.editableText.toString()
        assertTrue(controller.selectDisplayRange(0, view.length() - 1))
        runToolbar(controller, "code-block")
        val wrapped = controller.sourceText()!!
        assertEquals("all selected lines share one opening and closing fence", 2,
            wrapped.lineSequence().count { it == "```" })
        assertTrue(wrapped.startsWith("```\n"))
        assertTrue(wrapped.endsWith("\n```\n"))
        // One terminal body ending belongs to the hidden fence frame (fenced-code.md).
        val written = display.removeSuffix(TextFirstEditText.END_SENTINEL).removeSuffix("\n")
        assertEquals("the native projection retains every written line", written + TextFirstEditText.END_SENTINEL,
            view.editableText.toString())
        assertEquals("whole-note conversion is accepted", 0, controller.imeResets)
        controller.undo()
        assertEquals("one Undo restores exact mixed Markdown", original, controller.sourceText())
    }

    @Test fun repeatedFormatTogglesKeepComposedHeadingInput() = formatThenCompose("# heading")

    @Test fun repeatedFormatTogglesKeepComposedInputInADistantHeading() =
        formatThenCompose("plain paragraph\n\n".repeat(2_000) + "# heading")

    private fun formatThenCompose(raw: String) = withController(raw) { controller ->
        val view = controller.view
        view.requestFocus()
        // Opening a long note is progressive; this selection waits for the requested tail.
        val end = raw.substringBeforeLast("# heading").length + "heading".length
        assertTrue(controller.selectDisplayRange(end))
        val connection = view.onCreateInputConnection(android.view.inputmethod.EditorInfo())!!
        val formats = listOf(EditorInlineFormat.BOLD, EditorInlineFormat.ITALIC, EditorInlineFormat.STRIKE)
        var expected = view.editableText.toString()
        var at = end
        repeat(6) { round ->
            for (format in formats) {
                controller.format(format)
                controller.sourceText() // Each toolbar tap completes before the next one.
            }
            ime(view, connection) { setComposingText("w", 1) }
            ime(view, connection) { setComposingText("word", 1) }
            ime(view, connection) { commitText("word ", 1) }
            expected = expected.substring(0, at) + "word " + expected.substring(at)
            at += "word ".length
            assertEquals("composition survives repeated toggles in round $round", expected,
                view.editableText.toString())
            assertEquals("accepted input never restarts the IME", 0, controller.imeResets)
            assertTrue("the committed word is saved in source", controller.sourceText()!!.contains("word"))
        }
    }

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

    // Marked text is drawn with the formats it will have once committed
    // (interpretation-and-input.md, composition lines): Gboard sends a word as
    // composing text and commits it only on Space.
    @Test fun carriedBoldShowsWhileTheWordIsComposing() = composeAndCommit("text\n", 5, setOf(EditorInlineFormat.BOLD), EditorInlineFormat.BOLD)
    @Test fun carriedItalicShowsWhileTheWordIsComposing() = composeAndCommit("text\n", 5, setOf(EditorInlineFormat.ITALIC), EditorInlineFormat.ITALIC)
    @Test fun carriedStrikeShowsWhileTheWordIsComposing() = composeAndCommit("text\n", 5, setOf(EditorInlineFormat.STRIKE), EditorInlineFormat.STRIKE)
    @Test fun carriedCodeShowsWhileTheWordIsComposing() = composeAndCommit("text\n", 5, setOf(EditorInlineFormat.CODE), EditorInlineFormat.CODE)
    @Test fun carriedBoldShowsWhileComposingInAHeading() = composeAndCommit("# heading\n", 7, setOf(EditorInlineFormat.BOLD), EditorInlineFormat.BOLD)
    @Test fun boldToggledOffComposesPlain() = composeAndCommit("text\n", 5, emptySet(), EditorInlineFormat.BOLD, EditorInlineFormat.BOLD)
    @Test fun composingInsideABoldWordShowsBold() = composeAndCommit("a **bold** b", 4, setOf(EditorInlineFormat.BOLD))
    @Test fun composingInsideABoldWordAfterBoldOffShowsPlain() = composeAndCommit("a **bold** b", 4, emptySet(), EditorInlineFormat.BOLD)

    private fun composeAndCommit(raw: String, caret: Int, expected: Set<EditorInlineFormat>, vararg toggles: EditorInlineFormat) = withController(raw) { controller ->
        val view = controller.view
        view.requestFocus()
        assertTrue(controller.selectDisplayRange(caret))
        for (format in toggles) {
            controller.format(format)
            controller.sourceText() // Each toolbar tap completes before the next one.
        }
        val connection = view.onCreateInputConnection(android.view.inputmethod.EditorInfo())!!
        for (word in listOf("H", "He", "Hey")) {
            ime(view, connection) { setComposingText(word, 1) }
            assertEquals(word, view.editableText.substring(caret, caret + word.length))
            for (i in caret until caret + word.length) {
                assertEquals("composing '$word': character ${i - caret} is drawn in the formats it will commit with",
                    expected, drawnFormats(view.editableText, i))
            }
        }
        ime(view, connection) { commitText("Hey ", 1) }
        controller.sourceText() // Queue barrier: the commit's restyle has applied.
        for (i in caret until caret + 3) {
            assertEquals("committed character ${i - caret} keeps the formats it was composed with",
                expected, drawnFormats(view.editableText, i))
        }
    }

    private fun drawnFormats(text: android.text.Spanned, at: Int): Set<EditorInlineFormat> = buildSet {
        for (span in text.getSpans(at, at + 1, TfInline::class.java)) {
            if (text.getSpanStart(span) > at || text.getSpanEnd(span) < at + 1) continue
            if (span.bold) add(EditorInlineFormat.BOLD)
            if (span.italic) add(EditorInlineFormat.ITALIC)
            if (span.strike) add(EditorInlineFormat.STRIKE)
            if (span.code) add(EditorInlineFormat.CODE)
        }
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
