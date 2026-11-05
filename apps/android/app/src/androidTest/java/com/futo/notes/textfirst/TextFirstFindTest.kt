package com.futo.notes.textfirst

import android.graphics.Color
import android.view.inputmethod.EditorInfo
import androidx.activity.ComponentActivity
import androidx.core.content.res.ResourcesCompat
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import com.futo.notes.R
import java.io.File
import java.util.UUID
import kotlin.coroutines.resume
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import org.junit.Assert.*
import org.junit.Test
import uniffi.futo_notes_ffi.NoteStore

/** Find through the public controller seam: real session, real find rules, real table cells. */
class TextFirstFindTest {
    private val source = "Alpha café 😀 Beta\r\n\r\n**bold** alpha\r\n\r\n| 名称 | Value |\r\n| :--- | ---: |\r\n| ALPHA cell | x |\r\n\r\nend alpha\r\n"

    private fun <T> withNote(block: suspend (TextFirstController) -> T): T = runBlocking {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val root = File(context.cacheDir, "find-${UUID.randomUUID()}").apply { check(mkdirs()) }
        val scenario = ActivityScenario.launch(ComponentActivity::class.java)
        val store = NoteStore(root.path)
        lateinit var controller: TextFirstController
        try {
            store.createNote("find", "", source)
            withContext(Dispatchers.Main) {
                suspendCancellableCoroutine<Unit> { done -> scenario.onActivity { activity ->
                    controller = createTextFirstController(activity, { store }, root)
                    activity.setContentView(controller.view)
                    controller.open("find") { assertNull(it); done.resume(Unit) }
                } }
                block(controller)
            }
        } finally {
            withContext(Dispatchers.Main) { controller.discard(); controller.dispose() }
            scenario.close(); store.destroy(); root.deleteRecursively()
        }
    }

    private fun selection(c: TextFirstController) = c.view.selectionStart to c.view.selectionEnd

    @Test fun matchesFormattedUnicodeAndTableTextWithoutTouchingSource() = withNote { c ->
        val display = c.view.text.toString()
        val state = c.findSetQuery("alpha")!!
        assertEquals(4, state.total)
        assertEquals(1, state.current)
        val expected = Regex("alpha", RegexOption.IGNORE_CASE).findAll(display).map { it.range.first to it.range.last + 1 }.toList()
        assertEquals(expected, state.matches)
        assertEquals(source, c.sourceText())
        // Unicode: surrogate pair and accented letters are matched at their real UTF-16 positions.
        val emoji = c.findSetQuery("😀")!!
        assertEquals(1, emoji.total)
        assertEquals(display.indexOf("😀") to display.indexOf("😀") + 2, emoji.matches.single())
        assertEquals(1, c.findSetQuery("CAFÉ")!!.total)
        assertEquals(0, c.findSetQuery("no such text")!!.total)
        // Table padding and delimiters are never matched.
        assertEquals(0, c.findSetQuery("---")!!.total)
        assertEquals(source, c.sourceText())
    }

    @Test fun nextAndPreviousReachProseAndTheSameSessionCellField() = withNote { c ->
        val display = c.view.text.toString()
        c.findSetQuery("alpha")
        val prose = Regex("alpha", RegexOption.IGNORE_CASE).findAll(display).map { it.range.first to it.range.last + 1 }.toList()
        val first = c.findStep(true)!!
        assertEquals(1, first.current)
        assertEquals(prose[0], selection(c))
        assertEquals(2, c.findStep(true)!!.current)
        assertEquals(prose[1], selection(c))
        // The third match is inside a table cell: its editable field opens on exactly that text.
        assertEquals(3, c.findStep(true)!!.current)
        assertEquals("ALPHA cell", c.cellView!!.text.toString())
        assertEquals("ALPHA", c.cellView!!.text!!.substring(c.cellView!!.selectionStart, c.cellView!!.selectionEnd))
        // Leaving the cell for prose closes the cell window.
        assertEquals(4, c.findStep(true)!!.current)
        assertNull(c.cellView)
        assertEquals(prose[3], selection(c))
        // Wraps, then walks backwards into the cell again.
        assertEquals(1, c.findStep(true)!!.current)
        assertEquals(4, c.findStep(false)!!.current)
        assertEquals(3, c.findStep(false)!!.current)
        assertNotNull(c.cellView)
        assertEquals(source, c.sourceText())
    }

    @Test fun searchStepAndCloseLeaveSourceAndUndoHistoryAlone() = withNote { c ->
        c.select(0)
        val connection = c.view.onCreateInputConnection(EditorInfo())!!
        suspendCancellableCoroutine<Unit> { done -> connection.handler!!.post { connection.commitText("typed ", 1); done.resume(Unit) } }
        val edited = "typed $source"
        assertEquals(edited, c.sourceText())
        c.findSetQuery("alpha"); c.findStep(true); c.findStep(true); c.findStep(true)
        assertEquals(edited, c.sourceText())
        val closed = c.findClose()!!
        assertFalse(closed.open)
        assertEquals(0, closed.matches.size)
        assertEquals(edited, c.sourceText())
        // One Undo reverts exactly the typed edit: find added no history of its own.
        c.undo()
        assertEquals(source, c.sourceText())
        c.undo()
        assertEquals(source, c.sourceText())
    }

    @Test fun activeCompositionStaysIntactWhileFindIsUsed() = withNote { c ->
        c.select(0)
        val connection = c.view.onCreateInputConnection(EditorInfo())!!
        suspendCancellableCoroutine<Unit> { done -> connection.handler!!.post { connection.setComposingText("zz", 1); done.resume(Unit) } }
        c.sourceText() // drain the composition update to the view
        val caret = selection(c)
        assertEquals(4, c.findSetQuery("alpha")!!.total)
        c.findStep(true)
        assertEquals("a step during composition does not move the caret", caret, selection(c))
        assertNull(c.cellView)
        suspendCancellableCoroutine<Unit> { done -> connection.handler!!.post { connection.finishComposingText(); done.resume(Unit) } }
        assertEquals("zz$source", c.sourceText())
        c.findClose()
        assertEquals("zz$source", c.sourceText())
    }
}
