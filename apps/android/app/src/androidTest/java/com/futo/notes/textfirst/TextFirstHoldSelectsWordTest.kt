package com.futo.notes.textfirst

import android.os.SystemClock
import android.view.InputDevice
import android.view.MotionEvent
import android.view.ViewConfiguration
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Test
import uniffi.futo_notes_ffi.EditorInlineFormat

/**
 * Tester (round 3, N2): a text change that leaves a selection (an Undo restoring one, Bold on a held word) hides its
 * handles and menu but keeps it, and the next hold on another word brought them back instead of selecting the word.
 * A hold with the keyboard up selects the word under it, whatever selection stood.
 */
class TextFirstHoldSelectsWordTest {
    private val note = "alpha beta gamma\n\ndelta epsilon zeta\n"

    private fun touch(view: TextFirstEditText, down: Long, time: Long, action: Int, x: Float, y: Float) {
        val event = MotionEvent.obtain(down, time, action, x, y, 0)
        event.source = InputDevice.SOURCE_TOUCHSCREEN
        try { view.dispatchTouchEvent(event) } finally { event.recycle() }
    }

    private suspend fun holdWord(c: TextFirstController, word: String) {
        val view = c.view
        val (x, y) = withContext(Dispatchers.Main) {
            val at = view.editableText.indexOf(word) + 2
            val l = view.layout
            val line = l.getLineForOffset(at)
            (view.totalPaddingLeft + l.getPrimaryHorizontal(at)) to (view.totalPaddingTop - view.scrollY + (l.getLineTop(line) + l.getLineBottom(line)) / 2f)
        }
        val down = SystemClock.uptimeMillis()
        withContext(Dispatchers.Main) { touch(view, down, down, MotionEvent.ACTION_DOWN, x, y) }
        delay(ViewConfiguration.getLongPressTimeout() + 300L)
        withContext(Dispatchers.Main) { touch(view, down, SystemClock.uptimeMillis(), MotionEvent.ACTION_UP, x, y) }
        delay(400)
    }

    private suspend fun selected(c: TextFirstController): String = withContext(Dispatchers.Main) { c.view.editableText.substring(c.view.selectionStart, c.view.selectionEnd) }

    private suspend fun ready(c: TextFirstController) {
        withContext(Dispatchers.Main) { c.view.isFocusableInTouchMode = true; c.view.requestFocus() }
        withTimeout(5_000) { while (withContext(Dispatchers.Main) { c.view.layout == null }) delay(20) }
    }

    @Test fun aHoldAfterBoldOnAHeldWordSelectsTheNewWord() = textFirstSession(note) { c ->
        ready(c)
        holdWord(c, "beta")
        assertEquals("beta", selected(c))
        withContext(Dispatchers.Main) { c.toolbarFormat(EditorInlineFormat.BOLD) }
        withTimeout(5_000) { while (!(c.sourceText() ?: "").contains("**beta**")) delay(20) }
        delay(300)
        assertEquals("Bold keeps the word selected", "beta", selected(c))
        holdWord(c, "epsilon")
        assertEquals("the hold selects the word under it", "epsilon", selected(c))
    }

    @Test fun aHoldAfterAnUndoRestoredASelectionSelectsTheNewWord() = textFirstSession(note) { c ->
        ready(c)
        holdWord(c, "gamma")
        // Typed over, not Cut: the system's clipboard preview would take the window's focus from the tests after this one.
        textFirstIme(c) { commitText("x", 1) }
        withTimeout(5_000) { while ((c.sourceText() ?: "").contains("gamma")) delay(20) }
        c.undo()
        withTimeout(5_000) { while (!(c.sourceText() ?: "").contains("gamma")) delay(20) }
        delay(300)
        assertEquals("Undo restores the selection", "gamma", selected(c))
        holdWord(c, "zeta")
        assertEquals("the hold selects the word under it", "zeta", selected(c))
    }

    /** Sol (round 4): a hold inside a standing selection is the platform's (drag it, or its menu): the range stays. */
    @Test fun aHoldInsideASelectionKeepsIt() = textFirstSession(note) { c ->
        ready(c)
        val (start, end) = withContext(Dispatchers.Main) { c.view.editableText.let { it.indexOf("alpha") to it.indexOf("gamma") + 5 } }
        c.select(start, end)
        withTimeout(5_000) { while (withContext(Dispatchers.Main) { c.view.selectionEnd != end }) delay(20) }
        holdWord(c, "beta")
        assertEquals("the selection stands", "alpha beta gamma", selected(c))
    }

    /**
     * Sol (round 4): a long click with no press (an accessibility service's) is not a hold: the note does not end the
     * selection at the last touch's stale position. (What the platform's own long click then does is its own.)
     */
    @Test fun aLongClickWithNoPressDoesNotEndTheSelection() = textFirstSession(note) { c ->
        ready(c)
        holdWord(c, "epsilon")
        val (start, end) = withContext(Dispatchers.Main) { c.view.editableText.let { it.indexOf("alpha") to it.indexOf("beta") + 4 } }
        c.select(start, end)
        withTimeout(5_000) { while (withContext(Dispatchers.Main) { c.view.selectionStart != start }) delay(20) }
        withContext(Dispatchers.Main) { c.view.endSelectionUnderHold() }
        delay(300)
        assertEquals("the selection stands", "alpha beta", selected(c))
    }

    /**
     * Round 5 (tester): a hold inside a selection whose menu is open started the platform's text drag, which dropped
     * nothing (the engine's move is not offered to this editor). The hold lifts nothing: the selection and its menu stand.
     */
    @Test fun aHoldInsideASelectionWithItsMenuOpenLiftsNothing() = textFirstSession(note) { c ->
        ready(c)
        var menus = 0
        withContext(Dispatchers.Main) {
            val inner = c.view.customSelectionActionModeCallback
            c.view.customSelectionActionModeCallback = object : android.view.ActionMode.Callback {
                override fun onCreateActionMode(mode: android.view.ActionMode, menu: android.view.Menu): Boolean { menus++; return inner?.onCreateActionMode(mode, menu) ?: true }
                override fun onPrepareActionMode(mode: android.view.ActionMode, menu: android.view.Menu) = inner?.onPrepareActionMode(mode, menu) ?: false
                override fun onActionItemClicked(mode: android.view.ActionMode, item: android.view.MenuItem) = inner?.onActionItemClicked(mode, item) ?: false
                override fun onDestroyActionMode(mode: android.view.ActionMode) { menus--; inner?.onDestroyActionMode(mode) }
            }
        }
        holdWord(c, "epsilon")
        withTimeout(5_000) { while (withContext(Dispatchers.Main) { menus == 0 }) delay(20) }
        assertEquals("epsilon", selected(c))
        holdWord(c, "epsilon")
        delay(300)
        assertEquals("the selection stands", "epsilon", selected(c))
        assertEquals("its menu is open", 1, withContext(Dispatchers.Main) { menus })
    }
}
