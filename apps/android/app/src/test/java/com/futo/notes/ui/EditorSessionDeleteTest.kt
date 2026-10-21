package com.futo.notes.ui

import com.futo.notes.ui.SessionScope.scope
import com.futo.notes.ui.SessionScope.settle
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The delete exit, against the recording effects in EditorSessionTestDoubles.kt. */
class EditorSessionDeleteTest {
    @Test
    fun `delete latches the session closed before anything suspends`() = runBlocking {
        val scope = scope()
        val session = EditorSession(scope)
        val hold = CompletableDeferred<Unit>()
        val log = mutableListOf<String>()

        // An editor workflow is already running, so the delete cannot drain yet.
        scope.launch { session.runWork { hold.await() } }

        session.end(EditorExit.DELETE, RecordingEffects(log, name = "delete"))

        // Latched synchronously, in the window between the confirm tap and the
        // drain acquiring the lock — this is what stops a queued keystroke.
        assertTrue(session.isClosing)
        assertFalse(
            session.acceptsEditorChange(loaded = true, storageMigrationStarted = false),
        )

        hold.complete(Unit)
        scope.settle()

        // And nothing queued behind the latch may touch the note afterwards.
        assertNull(session.runWork { "queued after the latch" })
    }

    @Test
    fun `delete cancels the pending save, captures, commits, then deletes`() = runBlocking {
        val scope = scope()
        val session = EditorSession(scope)
        val log = mutableListOf<String>()
        val effects = RecordingEffects(log, name = "delete")

        session.end(EditorExit.DELETE, effects)
        scope.settle()

        assertEquals(
            listOf(
                "delete:prepare",
                "delete:awaitPendingWork:start",
                "delete:awaitPendingWork:end",
                "delete:cancelPendingSave",
                "delete:awaitCurrentBody",
                "delete:commitBody",
                "delete:perform",
                "delete:onSucceeded",
            ),
            log,
        )
        assertTrue(effects.succeeded)
    }

    @Test
    fun `delete waits for an in-flight workflow and remains the final mutation`() = runBlocking {
        val scope = scope()
        val session = EditorSession(scope)
        val started = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        val log = mutableListOf<String>()

        val work = scope.launch {
            session.runWork {
                started.complete(Unit)
                release.await()
                log += "work"
            }
        }
        started.await()

        session.end(EditorExit.DELETE, RecordingEffects(log, name = "delete"))
        release.complete(Unit)
        work.join()
        scope.settle()

        assertEquals("work", log.first { it == "work" || it.startsWith("delete:awaitCurrentBody") })
        assertTrue(log.indexOf("work") < log.indexOf("delete:perform"))
    }

    @Test
    fun `a failed delete unlatches so the editor is usable again`() = runBlocking {
        val scope = scope()
        val session = EditorSession(scope)
        val log = mutableListOf<String>()
        val effects = RecordingEffects(log, name = "delete", performs = { false })

        session.end(EditorExit.DELETE, effects)
        scope.settle()

        assertEquals(EditorExitFailure.ACTION, effects.failure)
        assertFalse(session.isClosing)
        assertTrue(session.acceptsEditorChange(loaded = true, storageMigrationStarted = false))
        assertEquals("resumed", session.runWork { "resumed" })
    }

    @Test
    fun `a delete whose draft write fails stops before deleting`() = runBlocking {
        val scope = scope()
        val session = EditorSession(scope)
        val log = mutableListOf<String>()
        val effects = RecordingEffects(log, name = "delete", bodyCommits = false)

        session.end(EditorExit.DELETE, effects)
        scope.settle()

        assertEquals(EditorExitFailure.BODY, effects.failure)
        assertFalse(log.contains("delete:perform"))
        assertFalse(session.isClosing)
    }

    /**
     * Back used to hold the pop until a WebView round trip and a disk write had
     * landed. It leaves first now, like the iOS back swipe, and the drain runs
     * after — still body before title, still under the session lock.
     */
}
