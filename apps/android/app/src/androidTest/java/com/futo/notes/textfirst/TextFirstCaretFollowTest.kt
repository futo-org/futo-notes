package com.futo.notes.textfirst

import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import androidx.activity.ComponentActivity
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import com.futo.notes.NotesStore
import com.futo.notes.localization.LocalLocalization
import com.futo.notes.localization.Localization
import com.futo.notes.ui.theme.FutoNotesTheme
import java.io.File
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import uniffi.futo_notes_ffi.EditorBlockCommand

/**
 * The caret stays on screen as a key grows the note under it: the frame that draws the key
 * already shows the caret. The real editor screen hosts the view, as the app does: under
 * Compose's AndroidView a pending layout is resolved during the draw without onLayout, which a
 * bare activity (or a bare AndroidView) hides.
 */
class TextFirstCaretFollowTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    private inner class Rig(val view: TextFirstEditText, val ic: InputConnection) {
        private val drawn = arrayOfNulls<CountDownLatch>(1)
        @Volatile private var overflowAtDraw = 0

        init {
            view.onFrameDrawn = {
                overflowAtDraw = lineBottom() - (view.height - view.extendedPaddingBottom)
                drawn[0]?.countDown()
            }
        }

        private fun lineBottom(): Int {
            val l = view.layout
            return l.getLineTop(l.getLineForOffset(view.selectionEnd) + 1) + view.totalPaddingTop - view.scrollY
        }

        /** Hand the editor thread [action] and wait for the frame that draws its result. */
        fun key(action: (InputConnection) -> Unit) {
            val latch = CountDownLatch(1)
            drawn[0] = latch
            ic.handler!!.post { action(ic) }
            assertTrue("the key was drawn", latch.await(5, TimeUnit.SECONDS))
        }

        fun type(text: String) = key { it.commitText(text, 1) }

        fun heading(level: UByte) {
            compose.runOnUiThread { view.engine!!.blockCommand(EditorBlockCommand.Heading(level)) }
            SystemClock.sleep(300)
        }

        /** Note a miss when the caret's line stuck out below the visible area in the frame that drew the last key. */
        fun assertCaretInView(label: String, misses: MutableList<String>) {
            if (overflowAtDraw > 0) misses += "$label: caret line was $overflowAtDraw px below the visible area"
        }
    }

    private fun exercise(note: String, check: Rig.() -> Unit) {
        NoteScrollMemory.clear()
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val scratch = File(context.cacheDir, "caret-follow-${UUID.randomUUID()}").apply { check(mkdirs()) }
        val root = File(scratch, "vault").apply { check(mkdirs()) }
        File(root, "draft.md").writeText(note)
        lateinit var store: NotesStore
        compose.runOnUiThread { store = NotesStore(root, File(scratch, "index")) }
        compose.waitUntil(15_000) { store.hasBootstrapped }
        val localization = Localization.fromGeneratedCatalogs(listOf("en"), "en-US")
        compose.setContent {
            FutoNotesTheme(darkTheme = false) {
                CompositionLocalProvider(LocalLocalization provides localization) {
                    TextFirstEditorScreen(store, "draft", false, false, {}, {}, registerLeave = { {} })
                }
            }
        }
        lateinit var editor: TextFirstEditText
        fun find(view: View): TextFirstEditText? = when (view) {
            is TextFirstEditText -> view
            is ViewGroup -> (0 until view.childCount).firstNotNullOfOrNull { find(view.getChildAt(it)) }
            else -> null
        }
        compose.waitUntil(15_000) {
            var ready = false
            compose.runOnUiThread {
                find(compose.activity.window.decorView)?.let { if (it.length() > 100) { editor = it; ready = true } }
            }
            ready
        }
        lateinit var ic: InputConnection
        compose.runOnUiThread {
            editor.requestFocus()
            editor.engine!!.hostSelect(editor.length() - 1, editor.length() - 1)
            ic = checkNotNull(editor.onCreateInputConnection(EditorInfo()))
        }
        SystemClock.sleep(500)
        Rig(editor, ic).check()
    }

    private val longNote = (1..60).joinToString("\n") { "line $it" }

    @Test
    fun enterAtTheBottomRevealsTheCaretInTheFrameThatDrawsIt() = exercise(longNote) {
        val misses = mutableListOf<String>()
        repeat(30) { n -> type("\n"); assertCaretInView("Enter $n", misses) }
        assertTrue(misses.joinToString("\n"), misses.isEmpty())
    }

    @Test
    fun typingAWrappedLineAtTheBottomRevealsTheCaretInTheFrameThatDrawsIt() = exercise(longNote) {
        val misses = mutableListOf<String>()
        repeat(120) { n -> type("word "); assertCaretInView("key $n", misses) }
        assertTrue(misses.joinToString("\n"), misses.isEmpty())
    }

    /** A new line, H1, a title, Return: the new line's caret is on screen at once, not clipped at the bottom edge. */
    @Test
    fun returnAfterAHeadingAtTheBottomRevealsTheNewLine() = exercise(longNote) {
        val misses = mutableListOf<String>()
        type("\n")
        heading(1u)
        type("Header")
        assertCaretInView("typing the heading", misses)
        repeat(5) { n -> type("\n"); assertCaretInView("Return $n", misses); type("x"); type("\n") }
        assertTrue(misses.joinToString("\n"), misses.isEmpty())
    }

    /** Typing at the bottom, then scrolling up to read: the note stays where the reader put it. */
    @Test
    fun scrollingAwayRightAfterAKeyIsNotUndoneWhenTheCursorBlinks() = exercise(longNote) {
        type("\n")
        compose.runOnUiThread { view.scroll.dragBy(-view.scrollY) }
        val readingAt = view.scrollY
        assertEquals("scrolled to the top", 0, readingAt)
        SystemClock.sleep(2000)
        assertEquals("the note was thrown back to the caret", readingAt, view.scrollY)
    }

    /**
     * The keyboard going away grows the view. A note scrolled to its end must not be left scrolled past
     * it: TextView only corrected that at its next reveal, so the first tap after the keyboard hid moved
     * the note under the finger and a double-tap landed on two different words.
     */
    @Test
    fun aNoteScrolledToItsEndIsNotLeftPastItWhenTheViewGrows() = exercise(longNote) {
        fun end() = view.layout.height + view.totalPaddingTop + view.totalPaddingBottom - view.height
        compose.runOnUiThread {
            view.scrollTo(0, end())
            view.layout(view.left, view.top, view.right, view.bottom + 400)
        }
        compose.runOnUiThread {
            assertTrue("scrolled ${view.scrollY}, past the note's end at ${end()}", view.scrollY <= end())
        }
    }

    @Test
    fun selectAllKeepsTheReadersScrollPosition() = exercise(longNote) {
        compose.runOnUiThread { view.scrollTo(0, view.maxScrollY() / 2) }
        val readingAt = view.scrollY
        assertTrue("the reader is in the middle of the note", readingAt > 0)
        compose.runOnUiThread { view.engine!!.selectAll() }
        compose.waitUntil(5_000) { view.selectionStart == 0 && view.selectionEnd == view.length() - 1 }
        // TextView's reveal normally runs at pre-draw, after the engine's selection echo.
        compose.waitForIdle()
        compose.runOnUiThread { view.bringPointIntoView(view.selectionEnd) }
        assertEquals("Select All must not jump to the selection's end", readingAt, view.scrollY)
    }

}
