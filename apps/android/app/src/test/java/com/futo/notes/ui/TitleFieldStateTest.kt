package com.futo.notes.ui

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.runtime.snapshots.Snapshot
import androidx.compose.ui.text.TextRange
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The debounced rename lands 500 ms after the last keystroke, often while the
 * title is still being typed. Rewriting the field then moved the caret: a title
 * the rename trimmed ("jkl " → "jkl") lost its space, so "jkl ", a pause, then
 * "mno" came out "jklmno"; before that, the caret went to 0 and "abc", a pause,
 * "def" came out "defabc".
 */
class TitleFieldStateTest {
    private val focused = TitleFieldState("Untitled").apply {
        focusChanged(true)
        typed("jkl ", TextRange(4))
    }
    private val edits = mutableListOf<String>()

    private fun TitleFieldState.typed(text: String, selection: TextRange) =
        textState.edit { replace(0, length, text); this.selection = selection }

    /** Runs [block] with [TitleFieldState.watchEdits] going, as the screen does. */
    private fun TitleFieldState.watched(block: suspend TitleFieldState.() -> Unit) = runBlocking {
        val watcher = launch { watchEdits { edits += it } }
        settle()
        block()
        watcher.cancel()
    }

    /** Lets the watcher see the latest edit, as the next frame would. */
    private suspend fun settle() {
        Snapshot.sendApplyNotifications()
        repeat(3) { yield() }
    }

    @Test
    fun `a title committed while the field is focused leaves what the user typed`() {
        focused.commit("jkl")

        assertEquals("jkl ", focused.text)
        assertEquals(TextRange(4), focused.textState.selection)
    }

    @Test
    fun `the committed title shows once the field loses focus, caret at its end`() {
        focused.commit("jkl")
        focused.focusChanged(false)

        assertEquals("jkl", focused.text)
        assertEquals(TextRange(3), focused.textState.selection)
    }

    @Test
    fun `typing after a commit wins over the committed title`() {
        focused.commit("jkl")
        focused.typed("jkl m", TextRange(5))
        focused.focusChanged(false)

        assertEquals("jkl m", focused.text)
    }

    // A sync rename landed while focused; typing a char and deleting it put the
    // text back, and blur used to bring the rename back over the user's edit.
    @Test
    fun `typing then deleting it still discards the committed title`() = focused.watched {
        commit("jkl")
        typed("jkl x", TextRange(5))
        settle()
        typed("jkl ", TextRange(4))
        settle()
        focusChanged(false)

        assertEquals("jkl ", text)
    }

    @Test
    fun `moving the caret is not typing`() = focused.watched {
        commit("jkl")
        textState.edit { selection = TextRange(1) }
        settle()
        focusChanged(false)

        assertEquals("jkl", text)
        assertEquals(emptyList<String>(), edits)
    }

    // Undo/redo bypass the input filter, so only the watcher sees them.
    @OptIn(ExperimentalFoundationApi::class)
    @Test
    fun `an undo while focused is the user's edit`() = focused.watched {
        commit("jkl")
        textState.undoState.undo()
        settle()
        focusChanged(false)

        assertEquals(listOf("Untitled"), edits)
        assertEquals("Untitled", text)
    }

    @Test
    fun `a title committed while the field is not focused shows at once`() =
        TitleFieldState("Note").watched {
            commit("Note-2")
            settle()

            assertEquals("Note-2", text)
            assertEquals(TextRange(6), textState.selection)
            assertEquals(emptyList<String>(), edits)
        }
}
