package com.futo.notes.textfirst

import android.view.KeyEvent
import android.view.inputmethod.EditorInfo
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
    @Test fun quoteButtonTakesTheQuoteOffAQuotedLine() =
        session("> quoted") { c -> c.select(2); c.block(EditorBlockCommand.Quote); assertEquals("quoted", c.sourceText()) }

    @Test fun codeButtonTakesTheLineOutOfItsFence() =
        session("```\ncode\n```") { c -> c.select(1); c.block(EditorBlockCommand.CodeBlock); assertEquals("code", c.sourceText()) }

    @Test fun enterOnTheEmptyLastCodeLineLeavesTheFence() = session("```\ncode\n\n```") { c ->
        c.select(5)
        enter(c)
        assertEquals("```\ncode\n```\n\n", c.sourceText())
    }

    /** The keyboard answers Enter on a selection by collapsing it and deleting the selected text first. */
    @Test fun enterOnASelectedImageKeepsItAndAddsALineBelow() = session("![](a.png)") { c ->
        c.view.selectedObject = 0 to 10
        c.select(0, 10)
        delay(300L)
        val connection = c.view.onCreateInputConnection(EditorInfo())!!
        connection.setSelection(10, 10)
        connection.deleteSurroundingText(10, 0)
        enter(c)
        assertEquals("![](a.png)\n", c.sourceText())
    }

    private suspend fun enter(c: TextFirstController) {
        val connection = c.view.onCreateInputConnection(EditorInfo())!!
        connection.sendKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_ENTER))
        delay(400L)
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
