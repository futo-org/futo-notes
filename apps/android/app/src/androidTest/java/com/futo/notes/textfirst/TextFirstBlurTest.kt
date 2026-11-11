package com.futo.notes.textfirst

import android.os.Bundle
import android.os.SystemClock
import android.view.ActionMode
import android.view.Window
import android.view.accessibility.AccessibilityNodeInfo
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import uniffi.futo_notes_ffi.EditorInlineFormat

/** Dropping the keyboard ends a selection and leaves the reader on the line they were reading. */
class TextFirstBlurTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    private val longNote = (0 until 60).joinToString("") { s ->
        "## Section $s\n\n" + (0 until 3).joinToString("") { p -> (0 until 40).joinToString(" ") { "w${s}x$p" } + "\n\n" }
    }

    @Test
    fun droppingTheKeyboardAfterSelectAllFromTheTextMenuKeepsTheReadersLine() = exercise {
        selectAllFromTheTextMenu()
        dismissAndAssertTheReaderStays()
    }

    /** Back closes the open text menu first; TextView then ends the range at its end, far below the screen. */
    @Test
    fun closingTheTextMenuAfterSelectAllKeepsTheReadersLine() = exercise {
        val menu = selectAllFromTheTextMenu()
        var readingAt = 0
        compose.runOnUiThread { readingAt = view.scrollY; menu.finish() }
        compose.waitForIdle()
        SystemClock.sleep(500)
        compose.runOnUiThread { view.bringPointIntoView(view.selectionEnd) }
        compose.runOnUiThread {
            assertTrue("the note keeps its keyboard", view.isFocused)
            assertEquals("the range ended: ${view.selectionStart}..${view.selectionEnd}", view.selectionStart, view.selectionEnd)
            assertEquals("closing the text menu must not move the note", readingAt, view.scrollY)
        }
    }

    @Test
    fun droppingTheKeyboardAfterUndoRestoredAWholeNoteSelectionEndsIt() = exercise {
        selectAll()
        engine.toggleFormat(EditorInlineFormat.BOLD)
        SystemClock.sleep(1_000)
        engine.undo()
        compose.waitUntil(5_000) { view.selectionStart == 0 && view.selectionEnd == view.length() - 1 }
        SystemClock.sleep(1_000)
        dismissAndAssertTheReaderStays()
    }

    private inner class Rig(val view: TextFirstEditText) {
        val engine get() = view.engine!!

        fun selectAll() {
            compose.runOnUiThread { engine.selectAll() }
            compose.waitUntil(15_000) { view.selectionStart == 0 && view.selectionEnd == view.length() - 1 }
            compose.waitForIdle()
        }

        /** Select All from the platform's text menu, which stays open (D8); returns that menu. */
        fun selectAllFromTheTextMenu(): ActionMode {
            val open = AtomicReference<ActionMode?>()
            compose.runOnUiThread {
                val window = compose.activity.window
                val original = window.callback
                window.callback = object : Window.Callback by original {
                    override fun onActionModeStarted(mode: ActionMode) { open.set(mode); original.onActionModeStarted(mode) }
                    override fun onActionModeFinished(mode: ActionMode) { open.compareAndSet(mode, null); original.onActionModeFinished(mode) }
                }
            }
            selectAWordMidScreen()
            compose.waitUntil(5_000) { open.get() != null }
            selectAll()
            compose.waitUntil(5_000) { open.get() != null }
            return open.get()!!
        }

        /** A word on screen selected the way a long press does, with the platform's text menu (LineSelectTouch.select). */
        fun selectAWordMidScreen() = compose.runOnUiThread {
            val l = view.layout
            val at = l.getLineStart(l.getLineForVertical(view.scrollY - view.totalPaddingTop + view.height / 2))
            view.performAccessibilityAction(AccessibilityNodeInfo.ACTION_SET_SELECTION, Bundle().apply {
                putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_START_INT, at)
                putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_END_INT, at + 2)
            })
        }

        /** The keyboard toolbar's chevron; the back gesture clears the same focus through Compose. */
        fun dismissAndAssertTheReaderStays() {
            var readingAt = 0
            compose.runOnUiThread {
                readingAt = view.scrollY
                assertTrue("the reader is mid-note, away from its end", readingAt in 1 until view.maxScrollY())
                view.hideKeyboard()
            }
            compose.waitForIdle()
            SystemClock.sleep(500)
            // TextView reveals the caret at pre-draw; run it once more deterministically.
            compose.runOnUiThread { view.bringPointIntoView(view.selectionEnd) }
            compose.runOnUiThread {
                assertFalse("the note lost focus", view.isFocused)
                assertEquals("no range remains: ${view.selectionStart}..${view.selectionEnd}", view.selectionStart, view.selectionEnd)
                assertEquals("dropping the keyboard must not move the note", readingAt, view.scrollY)
            }
            val engineSelection = IntArray(2)
            val read = CountDownLatch(1)
            engine.handler.post { engineSelection[0] = engine.selStart; engineSelection[1] = engine.selEnd; read.countDown() }
            assertTrue(read.await(5, TimeUnit.SECONDS))
            assertEquals("the engine's selection collapsed too", engineSelection[0], engineSelection[1])
        }
    }

    private fun exercise(check: Rig.() -> Unit) = compose.withTextFirstScreen(longNote) { view, _ ->
        compose.runOnUiThread {
            // The bare test activity has no AppCompat theme, so the EditText style that makes it focusable is absent.
            view.isFocusableInTouchMode = true
            view.requestFocus()
            view.scrollTo(0, view.maxScrollY() / 2)
        }
        compose.waitForIdle()
        Rig(view).check()
    }
}
