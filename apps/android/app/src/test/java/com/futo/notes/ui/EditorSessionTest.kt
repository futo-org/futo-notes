package com.futo.notes.ui

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.job
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The editor session's contract is an ORDER, so these tests inject recording
 * effects and assert the sequence the session drives them in. Everything the
 * old `EditorMutationGate` / `EditorNavigationAdmission` tests covered is here,
 * asserted through the verb the shell actually calls.
 */
class EditorSessionTest {
    /** Records every effect the session invokes, in order. */
    private class RecordingEffects(
        val log: MutableList<String>,
        val name: String = "exit",
        val attached: () -> Boolean = { true },
        val body: suspend () -> String? = { "body" },
        val bodyCommits: Boolean = true,
        val titleCommits: Boolean = true,
        val performs: suspend () -> Boolean = { true },
    ) : EditorExitEffects {
        var failure: EditorExitFailure? = null
        var succeeded = false
        var exitedWithoutEditor = false

        override fun isAttached(): Boolean = attached()

        override fun exitWithoutEditor() {
            exitedWithoutEditor = true
            log += "$name:exitWithoutEditor"
        }

        override fun prepare() {
            log += "$name:prepare"
        }

        override suspend fun cancelPendingSave() {
            log += "$name:cancelPendingSave"
        }

        override suspend fun captureBody(): String? {
            log += "$name:captureBody"
            return body()
        }

        override suspend fun commitBody(body: String): Boolean {
            log += "$name:commitBody"
            return bodyCommits
        }

        override suspend fun commitTitle(): Boolean {
            log += "$name:commitTitle"
            return titleCommits
        }

        override suspend fun perform(): Boolean {
            log += "$name:perform"
            return performs()
        }

        override fun onSucceeded() {
            succeeded = true
            log += "$name:onSucceeded"
        }

        override fun onFailed(failure: EditorExitFailure) {
            this.failure = failure
            log += "$name:onFailed(${failure.name})"
        }
    }

    /** Unconfined so `end`'s launched drain runs inline up to its first real
     *  suspension — the ordering under test is then observable directly. */
    private fun scope() = CoroutineScope(Dispatchers.Unconfined + Job())

    private suspend fun CoroutineScope.settle() {
        coroutineContext.job.children.forEach { it.join() }
    }

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
                "delete:cancelPendingSave",
                "delete:captureBody",
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

        assertEquals("work", log.first { it == "work" || it.startsWith("delete:captureBody") })
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

    @Test
    fun `navigation commits the body before the title, then leaves`() = runBlocking {
        val scope = scope()
        val session = EditorSession(scope)
        val log = mutableListOf<String>()

        session.end(EditorExit.NAVIGATE, RecordingEffects(log, name = "nav"))
        scope.settle()

        assertEquals(
            listOf(
                "nav:prepare",
                "nav:cancelPendingSave",
                "nav:captureBody",
                "nav:commitBody",
                "nav:commitTitle",
                "nav:perform",
                "nav:onSucceeded",
            ),
            log,
        )
    }

    @Test
    fun `navigation waits for an in-flight image workflow before it captures`() = runBlocking {
        val scope = scope()
        val session = EditorSession(scope)
        val started = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        val log = mutableListOf<String>()

        val image = scope.launch {
            session.runWork {
                started.complete(Unit)
                release.await()
                log += "image inserted"
            }
        }
        started.await()

        session.end(EditorExit.NAVIGATE, RecordingEffects(log, name = "nav"))
        release.complete(Unit)
        image.join()
        scope.settle()

        assertTrue(log.indexOf("image inserted") < log.indexOf("nav:captureBody"))
    }

    @Test
    fun `navigation refuses a second exit until the first one fails`() = runBlocking {
        val scope = scope()
        val locks = mutableListOf<Boolean>()
        val session = EditorSession(scope) { locks += it }
        val log = mutableListOf<String>()

        val blocked = RecordingEffects(log, name = "first", bodyCommits = false)
        val hold = CompletableDeferred<Unit>()
        val holdWork = scope.launch { session.runWork { hold.await() } }

        session.end(EditorExit.NAVIGATE, blocked)
        assertTrue(session.isInteractionLocked)

        // A second Back while the first exit is draining is dropped entirely.
        val second = RecordingEffects(log, name = "second")
        session.end(EditorExit.NAVIGATE, second)
        assertTrue(log.none { it.startsWith("second:") })

        hold.complete(Unit)
        holdWork.join()
        scope.settle()

        // The first exit failed, so the editor is usable and Back works again.
        assertEquals(EditorExitFailure.BODY, blocked.failure)
        assertFalse(session.isInteractionLocked)
        assertEquals(listOf(true, false), locks)

        val retry = RecordingEffects(log, name = "retry")
        session.end(EditorExit.NAVIGATE, retry)
        scope.settle()
        assertTrue(retry.succeeded)
    }

    @Test
    fun `navigation refuses to leave while a rename cannot commit`() = runBlocking {
        val scope = scope()
        val session = EditorSession(scope)
        val log = mutableListOf<String>()
        val effects = RecordingEffects(log, name = "nav", titleCommits = false)

        session.end(EditorExit.NAVIGATE, effects)
        scope.settle()

        assertEquals(EditorExitFailure.TITLE, effects.failure)
        assertFalse(log.contains("nav:perform"))
        assertFalse(session.isInteractionLocked)
    }

    @Test
    fun `navigation stops when the editor cannot hand back its body`() = runBlocking {
        val scope = scope()
        val session = EditorSession(scope)
        val log = mutableListOf<String>()
        val effects = RecordingEffects(log, name = "nav", body = { null })

        session.end(EditorExit.NAVIGATE, effects)
        scope.settle()

        assertEquals(EditorExitFailure.CAPTURE, effects.failure)
        assertFalse(log.contains("nav:commitBody"))
    }

    @Test
    fun `a detached session neither drains nor commits`() = runBlocking {
        val scope = scope()
        val session = EditorSession(scope)
        val log = mutableListOf<String>()
        val effects = RecordingEffects(log, name = "nav", attached = { false })

        session.end(EditorExit.NAVIGATE, effects)
        scope.settle()

        assertTrue(effects.exitedWithoutEditor)
        assertEquals(listOf("nav:exitWithoutEditor"), log)
        assertFalse(session.isInteractionLocked)
    }

    @Test
    fun `an exit that loses its attachment mid-drain never leaves`() = runBlocking {
        val scope = scope()
        val session = EditorSession(scope)
        val log = mutableListOf<String>()
        var attached = true
        // The editor is re-attached to another note while this exit commits.
        // The body still has to reach disk — it was captured while the
        // attachment was ours — but the navigation itself must not fire, and it
        // is not a failure the user should be told about.
        val effects = RecordingEffects(
            log,
            name = "nav",
            attached = { attached },
            body = { attached = false; "body" },
        )

        session.end(EditorExit.NAVIGATE, effects)
        scope.settle()

        assertEquals(
            listOf(
                "nav:prepare",
                "nav:cancelPendingSave",
                "nav:captureBody",
                "nav:commitBody",
                "nav:commitTitle",
            ),
            log,
        )
        assertNull(effects.failure)
        assertFalse(session.isInteractionLocked)
    }

    @Test
    fun `move commits the body and the move inside one drain`() = runBlocking {
        val scope = scope()
        val session = EditorSession(scope)
        val log = mutableListOf<String>()
        val queued = CompletableDeferred<Unit>()

        val effects = object : EditorExitEffects {
            override suspend fun captureBody(): String {
                log += "move:captureBody"
                return "body"
            }

            override suspend fun commitBody(body: String): Boolean {
                log += "move:commitBody"
                return true
            }

            override suspend fun perform(): Boolean {
                log += "move:perform"
                // A workflow queued behind the move must not interleave here:
                // it has to see the moved id, not the pre-move one.
                assertFalse(log.contains("queued work"))
                return true
            }

            override fun onSucceeded() {
                log += "move:onSucceeded"
            }
        }

        session.end(EditorExit.MOVE, effects)
        val queuedWork = scope.launch {
            session.runWork { log += "queued work" }
            queued.complete(Unit)
        }
        queuedWork.join()
        scope.settle()

        assertEquals(
            listOf(
                "move:captureBody",
                "move:commitBody",
                "move:perform",
                "move:onSucceeded",
                "queued work",
            ),
            log,
        )
    }

    @Test
    fun `move is rejected outright once a delete has latched`() = runBlocking {
        val scope = scope()
        val session = EditorSession(scope)
        val log = mutableListOf<String>()
        val hold = CompletableDeferred<Unit>()
        val holdWork = scope.launch { session.runWork { hold.await() } }

        session.end(EditorExit.DELETE, RecordingEffects(log, name = "delete"))
        val move = RecordingEffects(log, name = "move")
        session.end(EditorExit.MOVE, move)

        hold.complete(Unit)
        holdWork.join()
        scope.settle()

        assertEquals(EditorExitFailure.REJECTED, move.failure)
        assertFalse(log.contains("move:commitBody"))
    }

    @Test
    fun `editor changes are fenced before load, while closing, and during a storage migration`() {
        val session = EditorSession(scope())

        assertFalse(session.acceptsEditorChange(loaded = false, storageMigrationStarted = false))
        assertTrue(session.acceptsEditorChange(loaded = true, storageMigrationStarted = false))
        assertFalse(session.acceptsEditorChange(loaded = true, storageMigrationStarted = true))
    }
}
