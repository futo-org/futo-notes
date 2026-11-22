package com.futo.notes.textfirst

import android.view.KeyEvent
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.junit.Test
import uniffi.futo_notes_ffi.EditorBlockCommand

/**
 * Round 3 (N5, N6, and two reports from a phone nobody could reproduce): after a structural edit the file was right
 * and the screen was not, until a reopen. After each edit the view must hold exactly the spans a fresh open lays out.
 */
class TextFirstStructuralEditRenderTest {
    private val stress = "# 7. Checkboxes\n\nScroll so these sit mid screen.\n\n- [ ] One\n- [ ] Two\n- [x] Three\n  - [ ] Nested four\n- [ ] Five\n\n" +
        "# 8. Code blocks\n\nTap Copy in a header: one confirmation only.\n\n```python\ndef greet(name):\n    return f\"hello {name}\"\n```\n\n```\n```\n\nend\n"

    private suspend fun ready(c: TextFirstController) {
        withTimeout(5_000) { while (withContext(Dispatchers.Main) { c.view.layout == null }) delay(20) }
    }

    private suspend fun at(c: TextFirstController, text: String): Int = withContext(Dispatchers.Main) { c.view.editableText.indexOf(text).also { check(it >= 0) { "no $text" } } }

    private suspend fun settle(c: TextFirstController, what: String, done: (String) -> Boolean) {
        withTimeout(5_000) { while (!done(c.sourceText() ?: "")) delay(20) }
        delay(200)
    }

    private suspend fun enter(c: TextFirstController) = textFirstIme(c) {
        sendKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_ENTER))
        sendKeyEvent(KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_ENTER))
    }

    /** N6: tick One and Two, untick Three, type at One's end, Enter, type, Undo three times, Redo twice. */
    @Test fun undoAndRedoOfEnterInATaskListRestyleEveryRow() = textFirstSession(stress) { c ->
        ready(c)
        for (word in listOf("One", "Two", "Three")) { val offset = withContext(Dispatchers.Main) { c.view.editableText.let { it.lastIndexOf('\n', it.indexOf(word)) + 1 } }; withContext(Dispatchers.Main) { c.view.engine!!.toggleTaskAt(offset) } }
        settle(c, "the ticks") { it.contains("- [x] One\n- [x] Two\n- [ ] Three") }
        c.select(at(c, "One") + 3)
        delay(200)
        textFirstIme(c) { commitText("XY ", 1) }
        settle(c, "XY") { it.contains("OneXY ") }
        enter(c)
        settle(c, "the new item") { it.contains("OneXY \n- [ ] \n") }
        textFirstIme(c) { commitText("Delta", 1) }
        settle(c, "Delta") { it.contains("- [ ] Delta") }
        assertRendersAsFresh(c, "after typing")
        repeat(3) { c.undo(); delay(300) }
        assertRendersAsFresh(c, "after Undo x3")
        repeat(2) { c.redo(); delay(300) }
        assertRendersAsFresh(c, "after Redo x2")
    }

    /** N5: the python block dragged up above the task list; the paragraph that stood above it is prose again. */
    @Test fun aCodeBlockMovedUpLeavesTheParagraphAboveItProse() = textFirstSession(stress) { c ->
        ready(c)
        assertRendersAsFresh(c, "as opened")
        val code = at(c, "def greet")
        val slot = at(c, "One") - 1
        withContext(Dispatchers.Main) { val e = c.view.engine!!; e.handler.post { e.moveBlock(code, BlockSlot(slot, false)) } }
        settle(c, "the move") { it.contains("```\n- [ ] One") || it.contains("```\n\n- [ ] One") }
        assertRendersAsFresh(c, "after the move")
    }

    private val kinds = "Opening paragraph.\n\n# Heading one\n\n> quote one\n> quote two\n\n- bullet one\n- bullet two\n\n1. first\n2. second\n\n" +
        "- [ ] task one\n- [x] task two\n\n```js\nconst a = 1\n```\n\n| A | B |\n| --- | --- |\n| a1 | b1 |\n\n---\n\n![photo](missing.png)\n\nClosing paragraph.\n"

    /** Each kind of block moved to the top of the note and to its end, and back by Undo. */
    @Test fun everyKindOfBlockMovedRestylesEveryRow() = textFirstSession(kinds) { c ->
        ready(c)
        assertRendersAsFresh(c, "as opened")
        for (word in listOf("Heading one", "quote one", "bullet one", "first", "task one", "const a", "a1", "---", "photo", "Closing")) {
            for (top in listOf(true, false)) {
                val before = c.sourceText()
                val offset = at(c, word)
                withContext(Dispatchers.Main) { val e = c.view.engine!!; e.handler.post { e.moveBlock(offset, if (top) BlockSlot(0, false) else BlockSlot(e.mirror.text.length, true)) } }
                delay(500)
                // Already first or last: the engine moves nothing.
                if (c.sourceText() == before) continue
                assertRendersAsFresh(c, "$word moved to the ${if (top) "top" else "end"}")
                c.undo()
                withTimeout(5_000) { while (c.sourceText() != before) delay(20) }
                assertRendersAsFresh(c, "$word moved back by Undo")
            }
        }
    }

    /** Enter at the end of the first item of each kind of list, then Undo and Redo. */
    @Test fun enterInEveryKindOfListAndItsUndoAndRedoRestyleEveryRow() = textFirstSession(kinds) { c ->
        ready(c)
        for (word in listOf("bullet one", "first", "task one")) {
            val before = c.sourceText()
            c.select(at(c, word) + word.length)
            delay(200)
            enter(c)
            withTimeout(5_000) { while (c.sourceText() == before) delay(20) }
            assertRendersAsFresh(c, "Enter after $word")
            val entered = c.sourceText()
            c.undo()
            withTimeout(5_000) { while (c.sourceText() != before) delay(20) }
            assertRendersAsFresh(c, "Undo of Enter after $word")
            c.redo()
            withTimeout(5_000) { while (c.sourceText() != entered) delay(20) }
            assertRendersAsFresh(c, "Redo of Enter after $word")
        }
    }

    /** Code on and off a paragraph, and a list item indented and outdented. */
    @Test fun codeToggledAndItemsIndentedRestyleEveryRow() = textFirstSession(kinds) { c ->
        ready(c)
        for ((word, commands) in listOf("Opening" to listOf(EditorBlockCommand.WrapCodeBlock, EditorBlockCommand.WrapCodeBlock), "bullet two" to listOf(EditorBlockCommand.Indent, EditorBlockCommand.Outdent), "second" to listOf(EditorBlockCommand.Indent, EditorBlockCommand.Outdent))) {
            for (command in commands) {
                val before = c.sourceText()
                c.select(at(c, word) + 2)
                delay(200)
                withContext(Dispatchers.Main) { c.block(command) }
                withTimeout(5_000) { while (c.sourceText() == before) delay(20) }
                assertRendersAsFresh(c, "$command on $word")
            }
        }
    }
}
