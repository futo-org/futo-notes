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
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.junit.Assert.*
import org.junit.Test
import uniffi.futo_notes_ffi.NoteStore

/** Native input/controller + canonical completion, through the real store. */
class TextFirstCompletionTest {
    @Test
    fun unicodeCompletionAcceptsOneEditAndRejectsStaleClaims() = runBlocking {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val root = File(context.cacheDir, "completion-${UUID.randomUUID()}").apply { check(mkdirs()) }
        val scenario = ActivityScenario.launch(ComponentActivity::class.java)
        val store = NoteStore(root.path)
        lateinit var controller: TextFirstController
        val source = "before [[東 after\n"
        try {
            store.createNote("links", "", source)
            store.createNote("東京", "work", "destination")
            store.createNote("other", "", "other")
            withContext(Dispatchers.Main) {
                suspendCancellableCoroutine<Unit> { done ->
                    scenario.onActivity { activity ->
                        controller = createTextFirstController(activity, { store }, root)
                        activity.setContentView(controller.view)
                        controller.open("links") { assertNull(it); done.resume(Unit) }
                    }
                }
                controller.select(10)
                val completion = controller.completionDraft()!!
                assertEquals(listOf("work/東京"), completion.value.candidates.map { it.noteId })
                assertEquals("東京", completion.value.candidates.single().label)
                assertTrue(controller.acceptCompletion(completion, "work/東京"))
                assertEquals("before [[work/東京]] after\n", controller.sourceText())
                controller.undo()
                assertEquals(source, controller.sourceText())
                controller.select(10)
                val stale = controller.completionDraft()!!
                controller.select(0)
                assertFalse(controller.acceptCompletion(stale, "work/東京"))
                assertEquals(source, controller.sourceText())
                assertNotNull(controller.close())
            }
        } finally {
            withContext(Dispatchers.Main) { controller.discard(); controller.dispose() }
            scenario.close()
            store.destroy()
            root.deleteRecursively()
        }
    }

    @Test
    fun compositionAndDismissalPreserveTypingWithoutTakingSelection() = runBlocking {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val root = File(context.cacheDir, "completion-compose-${UUID.randomUUID()}").apply { check(mkdirs()) }
        val scenario = ActivityScenario.launch(ComponentActivity::class.java)
        val store = NoteStore(root.path)
        lateinit var controller: TextFirstController
        try {
            store.createNote("links", "", "before [[ after\n")
            store.createNote("東京", "work", "destination")
            withContext(Dispatchers.Main) {
                suspendCancellableCoroutine<Unit> { done ->
                    scenario.onActivity { activity ->
                        controller = createTextFirstController(activity, { store }, root)
                        activity.setContentView(controller.view)
                        controller.open("links") { assertNull(it); done.resume(Unit) }
                    }
                }
                controller.select(9)
                val connection = controller.view.onCreateInputConnection(EditorInfo())!!
                val beforeComposition = controller.completionDraft()!!
                suspendCancellableCoroutine<Unit> { done ->
                    connection.handler!!.post { connection.setComposingText("東", 1); done.resume(Unit) }
                }
                assertNull("Suggestions must not claim marked text", controller.completionDraft())
                assertFalse(controller.acceptCompletion(beforeComposition, "work/東京"))
                assertEquals("before [[ after\n", controller.sourceText())
                suspendCancellableCoroutine<Unit> { done ->
                    connection.handler!!.post { connection.finishComposingText(); done.resume(Unit) }
                }
                val draft = controller.completionDraft()!!
                assertEquals("東", draft.value.query)
                controller.dismissCompletion(draft)
                suspendCancellableCoroutine<Unit> { done ->
                    connection.handler!!.post { connection.setComposingText("京", 1); done.resume(Unit) }
                }
                assertNull(controller.completionDraft())
                suspendCancellableCoroutine<Unit> { done ->
                    connection.handler!!.post { connection.finishComposingText(); done.resume(Unit) }
                }
                assertNull("Dismissed run stays dismissed during typing", controller.completionDraft())
                assertEquals("before [[東京 after\n", controller.sourceText())
                assertEquals(11, controller.view.selectionStart)
                controller.select(0)
                assertNull(controller.completionDraft())
                controller.select(11)
                assertNotNull("Returning to the run permits completion again", controller.completionDraft())
                assertNotNull(controller.close())
            }
        } finally {
            withContext(Dispatchers.Main) { controller.discard(); controller.dispose() }
            scenario.close()
            store.destroy()
            root.deleteRecursively()
        }
    }

    /** A note created while the keyboard composes resolves the link once the composition ends, not before. */
    @Test
    fun aVaultChangeDuringCompositionResolvesTheLinkAfterIt() = runBlocking {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val root = File(context.cacheDir, "completion-vault-${UUID.randomUUID()}").apply { check(mkdirs()) }
        val scenario = ActivityScenario.launch(ComponentActivity::class.java)
        val store = NoteStore(root.path)
        lateinit var controller: TextFirstController
        try {
            val filler = "a line of filler that keeps the link far from the typing\n".repeat(80)
            store.createNote("links", "", "see [[Missing]]\n" + filler + "plain line\n")
            withContext(Dispatchers.Main) {
                suspendCancellableCoroutine<Unit> { done ->
                    scenario.onActivity { activity ->
                        controller = createTextFirstController(activity, { store }, root)
                        activity.setContentView(controller.view)
                        controller.open("links") { assertNull(it); done.resume(Unit) }
                    }
                }
                val view = controller.view
                fun linkTarget(): String? = view.editableText!!.getSpans(0, view.length(), TfWikilink::class.java).single().noteId
                assertNull("the link starts unresolved", linkTarget())
                controller.select(view.text.toString().indexOf("plain line") + "plain line".length)
                val connection = view.onCreateInputConnection(EditorInfo())!!
                suspendCancellableCoroutine<Unit> { done ->
                    connection.handler!!.post { connection.setComposingText("ab", 1); done.resume(Unit) }
                }
                store.createNote("Missing", "", "target")
                controller.refreshCompletionNoteIds()
                controller.completionDraft()
                assertEquals("the marked text is still uncommitted", "see [[Missing]]\n" + filler + "plain line\n", controller.sourceText())
                assertTrue("the marked text still shows", view.text.toString().contains("plain lineab"))
                assertNull("the link waits for the composition to end", linkTarget())
                suspendCancellableCoroutine<Unit> { done ->
                    connection.handler!!.post { connection.finishComposingText(); done.resume(Unit) }
                }
                withTimeout(5_000) { while (linkTarget() == null) delay(20L) }
                assertEquals("Missing", linkTarget())
                assertEquals("see [[Missing]]\n" + filler + "plain lineab\n", controller.sourceText())
                assertNotNull(controller.close())
            }
        } finally {
            withContext(Dispatchers.Main) { controller.discard(); controller.dispose() }
            scenario.close()
            store.destroy()
            root.deleteRecursively()
        }
    }

}
