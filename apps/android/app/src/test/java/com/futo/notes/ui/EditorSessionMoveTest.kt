package com.futo.notes.ui

import com.futo.notes.ui.SessionScope.scope
import com.futo.notes.ui.SessionScope.settle
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The move exit, against the recording effects in EditorSessionTestDoubles.kt. */
class EditorSessionMoveTest {
    @Test
    fun `move commits the body and the move inside one drain`() = runBlocking {
        val scope = scope()
        val session = EditorSession(scope)
        val log = mutableListOf<String>()
        val queued = CompletableDeferred<Unit>()

        val effects = object : EditorExitEffects {
            override suspend fun awaitCurrentBody(): String {
                log += "move:awaitCurrentBody"
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
                "move:awaitCurrentBody",
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

    /**
     * Move keeps the same attachment open afterward (it never disposes the
     * screen), so it does not lose an image the way navigation could — but it
     * still commits the pre-image body if it beats a picker round trip that
     * has not yet reached the session lock, leaving the moved file briefly
     * without the image until the next autosave. Waiting closes that window
     * the same way NAVIGATE does.
     */
    @Test
    fun `move waits for a picker round trip that has not yet reached the session lock`() =
        runBlocking {
            val scope = scope()
            val session = EditorSession(scope)
            val log = mutableListOf<String>()
            val pickerReturned = CompletableDeferred<Unit>()

            val effects = RecordingEffects(
                log,
                name = "move",
                awaitWork = { pickerReturned.await() },
            )

            session.end(EditorExit.MOVE, effects)

            assertTrue(log.none { it.startsWith("move:awaitCurrentBody") })
            assertFalse(effects.succeeded)

            pickerReturned.complete(Unit)
            scope.settle()

            assertEquals(
                listOf(
                    "move:prepare",
                    "move:awaitPendingWork:start",
                    "move:awaitPendingWork:end",
                    "move:cancelPendingSave",
                    "move:awaitCurrentBody",
                    "move:commitBody",
                    "move:perform",
                    "move:onSucceeded",
                ),
                log,
            )
        }
}
