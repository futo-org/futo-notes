package com.futo.notes.textfirst

import android.view.KeyEvent
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
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

/** A block can always be left: Enter past a selected image, Quote and Code block as toggles. */
class TextFirstExitTest {
    @Test fun undoAfterKeyboardPeriodRestoresTheOpeningCaret() = session("Pack ") { c ->
        c.select(5)
        ime(c) {
            // Gboard's observed double-space correction uses two nested batches.
            beginBatchEdit()
            beginBatchEdit()
            finishComposingText()
            setSelection(4, 5)
            commitText(". ", 1)
            endBatchEdit()
            endBatchEdit()
        }
        assertEquals("Pack. \n", c.sourceText())
        c.undo()
        assertEquals("Pack \n", c.sourceText())
        assertEquals(5, c.view.selectionStart)
        assertEquals(5, c.view.selectionEnd)
        ime(c) { commitText("now", 1) }
        assertEquals("Pack now\n", c.sourceText())
    }

    @Test fun keyboardReplacementSelectionIsOrdinaryOutsideItsPairedCommit() {
        for (kind in listOf("unbatched", "selection-only")) session("Pack ") { c ->
            c.select(5)
            ime(c) {
                if (kind != "unbatched") { beginBatchEdit(); beginBatchEdit() }
                setSelection(4, 5)
                if (kind == "selection-only") { endBatchEdit(); endBatchEdit() }
                commitText(". ", 1)
            }
            assertEquals("Pack. \n", c.sourceText())
            c.undo()
            assertEquals("Pack \n", c.sourceText())
            assertEquals("$kind start", 4, c.view.selectionStart)
            assertEquals("$kind end", 5, c.view.selectionEnd)
        }
    }

    @Test fun readingTheKeyboardReplacementRangeKeepsTheOpeningCaret() = session("Pack more") { c ->
        c.select(5)
        ime(c) {
            beginBatchEdit()
            beginBatchEdit()
            finishComposingText()
            setSelection(4, 5)
            assertEquals(" ", getSelectedText(0).toString())
            assertEquals("Pack", getTextBeforeCursor(20, 0).toString())
            assertEquals("more\n", getTextAfterCursor(20, 0).toString())
            val extracted = getExtractedText(android.view.inputmethod.ExtractedTextRequest(), 0)!!
            assertEquals(4, extracted.selectionStart)
            assertEquals(5, extracted.selectionEnd)
            getCursorCapsMode(android.text.TextUtils.CAP_MODE_SENTENCES)
            commitText(". ", 1)
            endBatchEdit()
            endBatchEdit()
        }
        assertEquals("Pack. more\n", c.sourceText())
        c.undo()
        assertEquals("Pack more\n", c.sourceText())
        assertEquals(5, c.view.selectionStart)
        assertEquals(5, c.view.selectionEnd)
        ime(c) { commitText("now ", 1) }
        assertEquals("Pack now more\n", c.sourceText())
    }

    @Test fun echoingTheKeyboardReplacementRangeKeepsTheOpeningCaret() = session("Pack ") { c ->
        c.select(5)
        ime(c) {
            beginBatchEdit()
            beginBatchEdit()
            finishComposingText()
            setSelection(4, 5)
            val extracted = getExtractedText(android.view.inputmethod.ExtractedTextRequest(), 0)!!
            assertEquals(4, extracted.selectionStart)
            assertEquals(5, extracted.selectionEnd)
            setSelection(4, 5)
            commitText(". ", 1)
            endBatchEdit()
            endBatchEdit()
        }
        assertEquals("Pack. \n", c.sourceText())
        c.undo()
        assertEquals("Pack \n", c.sourceText())
        assertEquals(5, c.view.selectionStart)
        assertEquals(5, c.view.selectionEnd)
    }

    @Test fun aKeyboardCorrectionUsesCellLocalCoordinatesAndKeepsTheOpeningCaret() =
        session("| Pack more | Owner |\n| --- | --- |\n") { c ->
            assertTrue(c.selectDisplayRange(7))
            ime(c, cell = true) {
                beginBatchEdit()
                finishComposingText()
                setSelection(4, 5)
                commitText(". ", 1)
                endBatchEdit()
            }
            assertEquals("| Pack. more | Owner |\n| --- | --- |\n", c.sourceText())
            c.undo()
            assertEquals("| Pack more | Owner |\n| --- | --- |\n", c.sourceText())
            assertEquals(7, c.view.selectionStart)
            assertEquals(7, c.view.selectionEnd)
            assertEquals(5, c.cellView!!.selectionStart)
            assertEquals(5, c.cellView!!.selectionEnd)
        }

    @Test fun anUnchangedKeyboardCorrectionMovesTheCaretWithoutHistory() = session("Pack more") { c ->
        c.select(9)
        ime(c) {
            beginBatchEdit()
            setSelection(4, 0)
            commitText("Pack", 1)
            endBatchEdit()
        }
        assertEquals("Pack more\n", c.sourceText())
        assertEquals(4, c.view.selectionStart)
        assertEquals(4, c.view.selectionEnd)
        c.undo()
        assertEquals("Pack more\n", c.sourceText())
        assertEquals(4, c.view.selectionStart)
    }

    @Test fun aStaleKeyboardReplacementCannotOverwriteAnInterveningEditOrSelection() {
        for (edit in listOf(true, false)) session("Pack ") { c ->
            c.select(5)
            ime(c) {
                beginBatchEdit()
                setSelection(4, 5)
                // A view/toolbar action may arrive between the keyboard's calls.
                val engine = c.view.engine!!
                if (edit) engine.imeCommit("X") else engine.imeSetSelection(0, 0)
                commitText(". ", 1)
                endBatchEdit()
            }
            assertEquals(if (edit) "Pack X\n" else "Pack \n", c.sourceText())
            assertEquals(if (edit) 6 else 0, c.view.selectionStart)
            assertEquals(c.view.selectionStart, c.view.selectionEnd)
            if (edit) {
                c.undo()
                assertEquals("Pack \n", c.sourceText())
                assertEquals(5, c.view.selectionStart)
                assertEquals(5, c.view.selectionEnd)
            }
        }
    }

    @Test fun undoAfterKeyboardDeletesACellSelectionRestoresItsRange() {
        for ((label, codePoints, backwards) in listOf(
            Triple("Item", false, true), Triple("\uD83D\uDE00", true, true), Triple("Item", false, false),
        )) {
            val source = "| $label | Owner |\n| --- | --- |\n"
            session(source) { c ->
                assertTrue(c.selectDisplayRange(2, 2 + label.length))
                ime(c, cell = true) {
                    beginBatchEdit()
                    val at = if (backwards) label.length else 0
                    setSelection(at, at)
                    val length = if (codePoints) 1 else label.length
                    val before = if (backwards) length else 0
                    val after = if (backwards) 0 else length
                    if (codePoints) deleteSurroundingTextInCodePoints(before, after)
                    else deleteSurroundingText(before, after)
                    endBatchEdit()
                }
                assertEquals("|  | Owner |\n| --- | --- |\n", c.sourceText())
                c.undo()
                assertEquals(source, c.sourceText())
                assertEquals(2, c.view.selectionStart)
                assertEquals(2 + label.length, c.view.selectionEnd)
                assertEquals(0, c.cellView!!.selectionStart)
                assertEquals(label.length, c.cellView!!.selectionEnd)
                ime(c, cell = true) { commitText("Revised", 1) }
                assertEquals("| Revised | Owner |\n| --- | --- |\n", c.sourceText())
                c.undo()
                assertEquals(source, c.sourceText())
                assertEquals(0, c.cellView!!.selectionStart)
                assertEquals(label.length, c.cellView!!.selectionEnd)
            }
        }
    }

    @Test fun aDeferredCellCollapseUsesTheCellsLocalCoordinates() =
        session("| Item | Owner |\n| --- | --- |\n") { c ->
            assertTrue(c.selectDisplayRange(2, 4))
            ime(c, cell = true) { beginBatchEdit(); setSelection(2, 2); endBatchEdit() }
            assertEquals("| Item | Owner |\n| --- | --- |\n", c.sourceText())
            assertEquals(4, c.view.selectionStart)
            assertEquals(4, c.view.selectionEnd)
            assertEquals(2, c.cellView!!.selectionStart)
            ime(c, cell = true) { commitText("X", 1) }
            assertEquals("| ItXem | Owner |\n| --- | --- |\n", c.sourceText())
            c.undo()
            assertEquals("| Item | Owner |\n| --- | --- |\n", c.sourceText())
            assertEquals(4, c.view.selectionStart)
            assertEquals(2, c.cellView!!.selectionStart)
        }

    @Test fun undoAfterKeyboardDeletesASelectionRestoresItsRange() = session("Meeting") { c ->
        c.select(0, 7)
        ime(c) {
            beginBatchEdit()
            setSelection(7, 7)
            deleteSurroundingText(7, 0)
            endBatchEdit()
        }
        assertEquals("\n", c.sourceText())
        c.undo()
        assertEquals("Meeting\n", c.sourceText())
        assertEquals(0, c.view.selectionStart)
        assertEquals(7, c.view.selectionEnd)
    }

    @Test fun batchedCaretCollapseStillAppliesBeforeTyping() = session("Meeting") { c ->
        c.select(0, 7)
        ime(c) {
            beginBatchEdit()
            setSelection(7, 7)
            commitText("!", 1)
            endBatchEdit()
        }
        assertEquals("Meeting!\n", c.sourceText())
        c.undo()
        assertEquals("Meeting\n", c.sourceText())
        assertEquals(7, c.view.selectionStart)
        assertEquals(7, c.view.selectionEnd)
    }

    @Test fun batchedCaretCollapseWithoutDeletionStillMovesTheCaret() = session("Meeting") { c ->
        c.select(0, 7)
        ime(c) { beginBatchEdit(); setSelection(7, 7); endBatchEdit() }
        assertEquals("Meeting\n", c.sourceText())
        assertEquals(7, c.view.selectionStart)
        assertEquals(7, c.view.selectionEnd)
    }

    @Test fun codePointSelectionDeletionRestoresTheWholeEmojiSelection() = session("a\uD83D\uDE00b") { c ->
        c.select(1, 3)
        ime(c) {
            beginBatchEdit()
            setSelection(3, 3)
            deleteSurroundingTextInCodePoints(1, 0)
            endBatchEdit()
        }
        assertEquals("ab\n", c.sourceText())
        c.undo()
        assertEquals("a\uD83D\uDE00b\n", c.sourceText())
        assertEquals(1, c.view.selectionStart)
        assertEquals(3, c.view.selectionEnd)
    }

    @Test fun aDifferentDeletionFootprintUsesTheCollapsedCaret() = session("Meeting") { c ->
        c.select(0, 7)
        ime(c) {
            beginBatchEdit()
            setSelection(7, 7)
            deleteSurroundingText(1, 0)
            endBatchEdit()
        }
        assertEquals("Meetin\n", c.sourceText())
        c.undo()
        assertEquals("Meeting\n", c.sourceText())
        assertEquals(7, c.view.selectionStart)
    }

    @Test fun quoteButtonTakesTheQuoteOffAQuotedLine() =
        session("> quoted\n") { c -> c.select(2); c.block(EditorBlockCommand.Quote); assertEquals("quoted\n", c.sourceText()) }

    @Test fun codeButtonTakesTheLineOutOfItsFence() =
        session("```\ncode\n```\n") { c -> c.select(1); c.block(EditorBlockCommand.CodeBlock); assertEquals("code\n", c.sourceText()) }

    @Test fun enterOnTheEmptyLastCodeLineLeavesTheFence() = session("```\ncode\n\n```") { c ->
        c.select(5)
        enter(c)
        assertEquals("```\ncode\n```\n\n", c.sourceText())
    }

    @Test fun enterOnAWholeCodeBodySelectionKeepsItsText() = session("```\ndeploy\n```") { c ->
        c.select(0, 6)
        enter(c)
        assertEquals("```\ndeploy\n```\n\n", c.sourceText())
    }

    @Test fun hardwareEnterOnAWholeCodeBodySelectionKeepsItsText() = session("```\ndeploy\n```") { c ->
        c.select(0, 6)
        hardwareEnter(c)
        assertEquals("```\ndeploy\n```\n\n", c.sourceText())
        c.undo()
        assertEquals("```\ndeploy\n```\n", c.sourceText())
        assertEquals(0, c.view.selectionStart)
        assertEquals(6, c.view.selectionEnd)
    }

    @Test fun softReturnOnAWholeCodeBodySelectionKeepsItsText() = session("```\ndeploy\n```") { c ->
        c.select(0, 6)
        ime(c) { commitText("\n", 1) }
        assertEquals("```\ndeploy\n```\n\n", c.sourceText())
    }

    @Test fun hardwareEnterReplacesAPartialCodeSelection() = session("```\ndeploy\n```") { c ->
        c.select(0, 3)
        hardwareEnter(c)
        assertEquals("```\n\nloy\n```\n", c.sourceText())
        c.undo()
        assertEquals("```\ndeploy\n```\n", c.sourceText())
        assertEquals(0, c.view.selectionStart)
        assertEquals(3, c.view.selectionEnd)
    }

    @Test fun keyboardBackspaceStillDeletesAWholeCodeBodySelection() = session("```\ndeploy\n```") { c ->
        c.select(0, 6)
        ime(c) {
            beginBatchEdit()
            setSelection(6, 6)
            deleteSurroundingText(6, 0)
            endBatchEdit()
        }
        assertEquals("```\n\n```\n", c.sourceText())
        c.undo()
        assertEquals("```\ndeploy\n```\n", c.sourceText())
        assertEquals(0, c.view.selectionStart)
        assertEquals(6, c.view.selectionEnd)
    }

    /** The keyboard answers Enter on a selection by collapsing it and deleting the selected text first. */
    @Test fun enterOnASelectedImageKeepsItAndAddsALineBelow() = session("![](a.png)\n") { c ->
        c.view.selectedObject = 0 to 10
        c.select(0, 10)
        delay(300L)
        ime(c) {
            setSelection(10, 10)
            deleteSurroundingText(10, 0)
        }
        enter(c)
        assertEquals("![](a.png)\n\n", c.sourceText())
    }

    private suspend fun enter(c: TextFirstController) = ime(c) { sendKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_ENTER)) }

    /** Gboard's observed fallback when the view lets a hardware Enter reach the IME. */
    private suspend fun hardwareEnter(c: TextFirstController) {
        // Host selection posts to the editor thread; a window key arrives only
        // after the resulting native selection has been shown.
        c.sourceText()
        val event = KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_ENTER)
        if (!c.view.dispatchKeyEventPreIme(event)) {
            val end = c.view.selectionEnd
            val length = end - c.view.selectionStart
            ime(c) {
                beginBatchEdit()
                setSelection(end, end)
                deleteSurroundingText(length, 0)
                endBatchEdit()
                sendKeyEvent(event)
            }
        }
        c.view.dispatchKeyEventPreIme(KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_ENTER))
    }

    /**
     * Keyboard calls arrive on the connection's handler, as the system delivers
     * them; calling them on the main thread raced the posted selection and Enter
     * landed at the old caret.
     */
    private suspend fun ime(c: TextFirstController, cell: Boolean = false, call: InputConnection.() -> Unit) {
        val connection = (if (cell) c.cellView!! else c.view).onCreateInputConnection(EditorInfo())!!
        suspendCancellableCoroutine<Unit> { done ->
            connection.handler!!.post { connection.call(); c.view.post { done.resume(Unit) } }
        }
    }

    private fun session(raw: String, body: suspend (TextFirstController) -> Unit) = runBlocking {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val root = File(context.cacheDir, "exit-${UUID.randomUUID()}").apply { check(mkdirs()) }
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
                controller.view.requestFocus()
                delay(300L)
                body(controller)
            }
        } finally {
            withContext(Dispatchers.Main) { controller.discard(); controller.dispose() }
            scenario.close()
            store.destroy()
            root.deleteRecursively()
        }
    }
}
