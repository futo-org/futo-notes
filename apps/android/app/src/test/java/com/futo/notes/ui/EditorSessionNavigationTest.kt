package com.futo.notes.ui

import com.futo.notes.ui.SessionScope.scope
import com.futo.notes.ui.SessionScope.settle
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineExceptionHandler
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

/** The navigation exit, against the recording effects in EditorSessionTestDoubles.kt. */
class EditorSessionNavigationTest {
    @Test
    fun `navigation leaves first, then commits the body before the title`() = runBlocking {
        val scope = scope()
        val session = EditorSession(scope)
        val log = mutableListOf<String>()

        session.end(EditorExit.NAVIGATE, RecordingEffects(log, name = "nav"))
        scope.settle()

        assertEquals(
            listOf(
                    "nav:prepare",
                    "nav:awaitPendingWork:start",
                    "nav:awaitPendingWork:end",
                    "nav:perform",
                    "nav:onSucceeded",
                    "nav:cancelPendingSave",
                    "nav:awaitCurrentBody",
                    "nav:commitBody",
                    "nav:commitTitle",
            ),
            log,
        )
        // The screen is going away: the exit keeps its latch.
        assertTrue(session.isInteractionLocked)
    }

    /**
     * The commit outlives the screen. The screen's composition scope is
     * cancelled when the pop animation ends; a commit still waiting on the
     * editor or the disk then must keep going on the scope it was handed.
     */
    @Test
    fun `navigation's commit survives the screen scope that started it`() = runBlocking {
        val screen = scope()
        val store = scope()
        val session = EditorSession(screen, launchCommit = { block -> store.launch { block() } })
        val log = mutableListOf<String>()
        val bodyArrives = CompletableDeferred<String>()

        session.end(EditorExit.NAVIGATE, RecordingEffects(log, name = "nav", body = { bodyArrives.await() }))
        assertTrue(log.contains("nav:perform"))
        assertFalse(log.contains("nav:commitBody"))

        screen.coroutineContext.job.cancel()
        bodyArrives.complete("body")
        store.settle()

        assertEquals(listOf("nav:commitBody", "nav:commitTitle"), log.takeLast(2))
    }

    /**
     * The screen's leave work (fallback flush, untouched-capture delete, draft
     * register release) waits for the commit. Run alongside it, the fallback
     * flush wrote the same body against the same base a second time and parked
     * a conflict copy, and the capture check read a body the editor had not
     * reported yet.
     */
    @Test
    fun `leave work waits for the commit navigation started after leaving`() = runBlocking {
        val scope = scope()
        val session = EditorSession(scope)
        val log = mutableListOf<String>()
        val bodyArrives = CompletableDeferred<String>()

        session.whenExitSettles { log += "leave work, no exit" }
        session.end(EditorExit.NAVIGATE, RecordingEffects(log, name = "nav", body = { bodyArrives.await() }))
        session.whenExitSettles { log += "leave work" }
        assertFalse(log.contains("leave work"))

        bodyArrives.complete("body")
        scope.settle()

        assertEquals(
            listOf("leave work, no exit", "nav:commitTitle", "leave work"),
            log.filter { it.startsWith("leave work") || it == "nav:commitTitle" },
        )
    }

    @Test
    fun `a commit that throws after leaving is reported and still settles`() = runBlocking {
        val scope = scope()
        val session = EditorSession(scope)
        val log = mutableListOf<String>()
        val effects = RecordingEffects(log, name = "nav", body = { throw IllegalStateException("disk gone") })

        session.end(EditorExit.NAVIGATE, effects)
        session.whenExitSettles { log += "leave work" }
        scope.settle()

        assertTrue(effects.succeeded)
        assertEquals(EditorExitFailure.THREW, effects.failure)
        assertEquals("leave work", log.last())
    }

    /** A delete (or a peer's delete) latched first owns the leave; a navigation
     *  alongside it would pop a second screen. */
    @Test
    fun `navigation is dropped once a destructive exit has latched`() = runBlocking {
        val scope = scope()
        val session = EditorSession(scope)
        val log = mutableListOf<String>()
        val hold = CompletableDeferred<Unit>()

        session.end(
            EditorExit.DELETE,
            RecordingEffects(log, name = "delete", performs = { hold.await(); true }),
        )
        session.end(EditorExit.NAVIGATE, RecordingEffects(log, name = "nav"))
        hold.complete(Unit)
        scope.settle()

        assertTrue(log.none { it.startsWith("nav:") })
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

        assertTrue(log.indexOf("image inserted") < log.indexOf("nav:awaitCurrentBody"))
    }

    /**
     * The bug this closes: the picker round trip for "Choose from library" /
     * camera runs OUTSIDE [EditorSession] entirely while the system picker
     * Activity has focus, and only calls [EditorSession.runWork] once it
     * returns. [runWork]'s mutex only orders work that has already reached
     * it (see the test above) — it cannot order against a producer that has
     * not been scheduled yet. Triage on a real device found the exit reaching
     * [EditorSession.end] and draining an empty, untouched body to
     * completion BEFORE the picker's callback ever ran, which let
     * `NoteEditorScreen`'s onDispose delete the just-created note as
     * "untouched" — and the picker's insert then aborted silently against
     * the now-detached attachment, losing the image too. This models that
     * gap directly: the "picker" here is a bare suspend function the effects
     * object awaits, never touching the session lock until it resolves — the
     * exit must not drain until it does.
     */
    @Test
    fun `navigation waits for a picker round trip that has not yet reached the session lock`() =
        runBlocking {
            val scope = scope()
            val session = EditorSession(scope)
            val log = mutableListOf<String>()
            val pickerReturned = CompletableDeferred<Unit>()

            val effects = RecordingEffects(
                log,
                name = "nav",
                awaitWork = { pickerReturned.await() },
            )

            session.end(EditorExit.NAVIGATE, effects)

            // Still waiting on the picker: nothing has been captured, let alone
            // committed or navigated — the note must not be deletable yet, and
            // the insert still needs this screen's editor attachment.
            assertTrue(log.none { it.startsWith("nav:awaitCurrentBody") })
            assertFalse(log.contains("nav:perform"))
            assertFalse(effects.succeeded)

            pickerReturned.complete(Unit)
            scope.settle()

            assertEquals(
                listOf(
                        "nav:prepare",
                        "nav:awaitPendingWork:start",
                        "nav:awaitPendingWork:end",
                        "nav:perform",
                        "nav:onSucceeded",
                        "nav:cancelPendingSave",
                        "nav:awaitCurrentBody",
                        "nav:commitBody",
                        "nav:commitTitle",
                ),
                log,
            )
        }

    @Test
    fun `navigation refuses a second exit, and a failed commit cannot call the user back`() =
        runBlocking {
            val scope = scope()
            val locks = mutableListOf<Boolean>()
            val session = EditorSession(scope, onInteractionLockChanged = { locks += it })
            val log = mutableListOf<String>()

            val blocked = RecordingEffects(log, name = "first", bodyCommits = false)
            val hold = CompletableDeferred<Unit>()
            val holdWork = scope.launch { session.runWork { hold.await() } }

            session.end(EditorExit.NAVIGATE, blocked)
            assertTrue(session.isInteractionLocked)
            // Left already, while an autosave still holds the lock.
            assertTrue(log.contains("first:perform"))
            assertFalse(log.contains("first:commitBody"))

            // A second Back while the first exit is committing is dropped entirely.
            val second = RecordingEffects(log, name = "second")
            session.end(EditorExit.NAVIGATE, second)
            assertTrue(log.none { it.startsWith("second:") })

            hold.complete(Unit)
            holdWork.join()
            scope.settle()

            // The body did not commit: reported, and left to the screen's leave
            // work. The screen is gone, so nothing unlatches.
            assertEquals(EditorExitFailure.BODY, blocked.failure)
            assertFalse(log.contains("first:commitTitle"))
            assertTrue(session.isInteractionLocked)
            assertEquals(listOf(true), locks)
        }

    /**
     * F3: `end()`'s unlatch used to live only in the ordinary "the exit
     * returned false" branch. `awaitCurrentBody`/`commitBody`/`perform` are
     * arbitrary suspend calls into the shell, and none of them are
     * guaranteed to fail by RETURNING false — a genuinely unexpected error
     * throws instead. Without a `finally`, that exception unwound straight
     * out of the launched coroutine and skipped the unlatch entirely,
     * leaving [EditorSession.isInteractionLocked] true forever: Back, the
     * toolbar, and every text field stayed dead until process death, because
     * nothing ever ran to flip it back.
     *
     * The test scope needs its own [CoroutineExceptionHandler] for a reason
     * worth being explicit about: `rememberCoroutineScope()` — what
     * `NoteEditorScreen` actually passes to [EditorSession] — hands `end()`'s
     * `scope.launch` a plain (non-supervisor) `Job`, the same shape used
     * here. A handler is what stops an uncaught exception there from
     * crashing the whole app instead of merely failing this one exit; this
     * test is asserting the unlatch behavior for whichever of those two
     * outcomes is in effect, not asserting that the app survives. A second
     * `end()` call on the SAME scope after the throw is deliberately not
     * asserted here: a plain `Job`'s failure semantics cancel the scope
     * itself (structured concurrency, independent of anything in this
     * class), so whether a retry can still run depends on that scope
     * choice, not on this fix.
     */
    @Test
    fun `an effect that throws still releases the interaction lock`() = runBlocking {
        val scope = CoroutineScope(
            Dispatchers.Unconfined + Job() + CoroutineExceptionHandler { _, _ -> },
        )
        val locks = mutableListOf<Boolean>()
        val session = EditorSession(scope, onInteractionLockChanged = { locks += it })
        val log = mutableListOf<String>()
        val boom = IllegalStateException("renderer wedged")
        val effects = RecordingEffects(log, name = "nav", performs = { throw boom })

        session.end(EditorExit.NAVIGATE, effects)
        scope.settle()

        assertFalse(session.isInteractionLocked)
        assertEquals(listOf(true, false), locks)
    }

    /** iOS parity (the back swipe): the body is already committed, and a
     *  rename that cannot land is reported after leaving, not a reason to stay. */
    @Test
    fun `a rename that cannot commit is reported after leaving`() = runBlocking {
        val scope = scope()
        val session = EditorSession(scope)
        val log = mutableListOf<String>()
        val effects = RecordingEffects(log, name = "nav", titleCommits = false)

        session.end(EditorExit.NAVIGATE, effects)
        scope.settle()

        assertEquals(EditorExitFailure.TITLE, effects.failure)
        assertTrue(effects.succeeded)
        assertTrue(log.indexOf("nav:commitBody") < log.indexOf("nav:commitTitle"))
    }

    @Test
    fun `a body the editor cannot hand back is never committed in its place`() = runBlocking {
        val scope = scope()
        val session = EditorSession(scope)
        val log = mutableListOf<String>()
        val effects = RecordingEffects(log, name = "nav", body = { null })

        session.end(EditorExit.NAVIGATE, effects)
        scope.settle()

        assertEquals(EditorExitFailure.UNFLUSHED, effects.failure)
        assertTrue(effects.succeeded)
        assertFalse(log.contains("nav:commitBody"))
        assertFalse(log.contains("nav:commitTitle"))
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
    fun `an exit that loses its attachment before leaving commits but never leaves`() = runBlocking {
        val scope = scope()
        val session = EditorSession(scope)
        val log = mutableListOf<String>()
        var attached = true
        // The editor is re-attached to another note between Back and the
        // leave. The body still has to reach disk — the exit was admitted
        // while the attachment was ours — but the navigation itself must not
        // fire, and it is not a failure the user should be told about.
        val effects = RecordingEffects(
            log,
            name = "nav",
            attached = { attached },
            awaitWork = { attached = false },
        )

        session.end(EditorExit.NAVIGATE, effects)
        scope.settle()

        assertEquals(
            listOf(
                "nav:prepare",
                "nav:awaitPendingWork:start",
                "nav:awaitPendingWork:end",
                "nav:cancelPendingSave",
                "nav:awaitCurrentBody",
                "nav:commitBody",
                "nav:commitTitle",
            ),
            log,
        )
        assertNull(effects.failure)
        assertFalse(session.isInteractionLocked)
    }
}
