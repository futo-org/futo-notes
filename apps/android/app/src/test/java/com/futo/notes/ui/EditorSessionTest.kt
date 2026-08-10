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
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import uniffi.futo_notes_ffi.KeepDraftReason
import uniffi.futo_notes_ffi.OpenNoteDisposition
import uniffi.futo_notes_ffi.OpenNoteFacts

/**
 * The editor session's contract is an ORDER, so these tests inject recording
 * effects and assert the sequence the session drives them in. Everything the
 * old `EditorMutationGate` / `EditorNavigationAdmission` tests covered is here,
 * asserted through the verb the shell actually calls.
 */
class EditorSessionTest {
    private class RecordingOpenNoteEffects(
        var noteId: String = "note",
        val dispositions: ArrayDeque<OpenNoteDisposition>,
        val log: MutableList<String>,
        val duringFacts: (() -> Unit)? = null,
        /** Suspends inside the gather, so a test can act while the session
         *  lock is held by an in-flight reconciliation. */
        val gatherGate: (suspend () -> Unit)? = null,
        val isCurrentEditor: () -> Boolean = { true },
        val gatherFailure: Exception? = null,
    ) : OpenNoteEffects {
        override fun currentNoteId(): String = noteId

        override fun isCurrentEditor(): Boolean = isCurrentEditor.invoke()

        override suspend fun gatherFacts(noteId: String): OpenNoteFacts {
            log += "facts:$noteId"
            duringFacts?.invoke()
            gatherGate?.invoke()
            gatherFailure?.let { throw it }
            return OpenNoteFacts(
                base = "base",
                draft = "draft",
                disk = "disk",
                renamedTo = null,
                editorFocused = true,
                editedDuringCycle = false,
            )
        }

        override fun classify(facts: OpenNoteFacts): OpenNoteDisposition {
            log += "classify"
            return dispositions.removeFirst()
        }

        override fun apply(
            noteId: String,
            disposition: OpenNoteDisposition,
        ) {
            log += "apply:$noteId:${disposition::class.simpleName}"
            if (disposition is OpenNoteDisposition.FollowRename) {
                this.noteId = disposition.toId
            }
        }

        override fun resumeDraftPersistence() {
            log += "resume-draft"
        }
    }

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
    fun `open-note reconciliation renders every engine disposition`() = runBlocking {
        val dispositions = listOf(
            OpenNoteDisposition.Leave,
            OpenNoteDisposition.Adopt("peer"),
            OpenNoteDisposition.KeepDraft("peer", KeepDraftReason.DIVERGED),
        )

        dispositions.forEach { disposition ->
            val log = mutableListOf<String>()
            val session = EditorSession(scope())
            session.reconcileOpenNote(
                RecordingOpenNoteEffects(
                    dispositions = ArrayDeque(listOf(disposition)),
                    log = log,
                ),
            )
            val expected = mutableListOf("facts:note", "classify")
            if (disposition === OpenNoteDisposition.Leave) expected += "resume-draft"
            expected += "apply:note:${disposition::class.simpleName}"
            assertEquals(expected, log)
        }

        val closeLog = mutableListOf<String>()
        val closingSession = EditorSession(scope())
        closingSession.reconcileOpenNote(
            RecordingOpenNoteEffects(
                dispositions = ArrayDeque(listOf(OpenNoteDisposition.Close)),
                log = closeLog,
            ),
        )
        assertTrue(closingSession.isClosing)
        assertEquals(
            listOf("facts:note", "classify", "apply:note:Close"),
            closeLog,
        )
    }

    @Test
    fun `focused adoption is deferred exactly until the session settles on blur`() = runBlocking {
        val log = mutableListOf<String>()
        val session = EditorSession(scope())
        val effects = RecordingOpenNoteEffects(
            dispositions = ArrayDeque(
                listOf(OpenNoteDisposition.DeferAdopt, OpenNoteDisposition.Adopt("peer")),
            ),
            log = log,
        )

        session.reconcileOpenNote(effects)
        session.settleDeferredAdoption(effects)

        assertEquals(
            listOf(
                "facts:note",
                "classify",
                "apply:note:DeferAdopt",
                "facts:note",
                "classify",
                "apply:note:Adopt",
            ),
            log,
        )
    }

    /**
     * The blur edge is not synchronised with the cycle that produces the
     * deferral: the reconciliation suspends on its disk read while still
     * holding the session lock, and the user can blur in that window. Reading
     * the deferral before taking the lock made that settle pass see "nothing
     * deferred", so the peer's content was stranded on the editor's next blur
     * and every one after it (there is no further focus edge to settle on).
     */
    @Test
    fun `a blur racing the deferral still settles it exactly once`() = runBlocking {
        val log = mutableListOf<String>()
        val scope = scope()
        val session = EditorSession(scope)
        val reachedFacts = CompletableDeferred<Unit>()
        val releaseFacts = CompletableDeferred<Unit>()
        val effects = RecordingOpenNoteEffects(
            dispositions = ArrayDeque(
                listOf(OpenNoteDisposition.DeferAdopt, OpenNoteDisposition.Adopt("peer")),
            ),
            log = log,
            gatherGate = {
                if (reachedFacts.complete(Unit)) releaseFacts.await()
            },
        )

        val reconcile = scope.launch { session.reconcileOpenNote(effects) }
        reachedFacts.await()
        // The blur lands while the cycle that will defer is still in flight.
        val settle = scope.launch { session.settleDeferredAdoption(effects) }
        releaseFacts.complete(Unit)
        reconcile.join()
        settle.join()

        assertEquals(
            listOf(
                "facts:note",
                "classify",
                "apply:note:DeferAdopt",
                "facts:note",
                "classify",
                "apply:note:Adopt",
            ),
            log,
        )

        // The deferral is spent: a later blur must not re-apply it.
        log.clear()
        session.settleDeferredAdoption(effects)
        assertEquals(emptyList<String>(), log)
    }

    /**
     * Persist-or-park at the open-note seam: the settle pass RE-GATHERS and
     * re-asks, so a draft that turned dirty between the deferral and the blur
     * is kept and rebased instead of being replaced by the peer's bytes. The
     * classification itself belongs to the engine (`a_dirty_draft_is_never_
     * replaced` in crates/futo-notes-sync/src/open_note.rs, unreachable from a
     * JVM unit test — no loadable JNI library); what the session owes is asking
     * again with the draft as it is at blur time, never reusing the deferral's
     * verdict. The classifier here answers exactly as the engine does for these
     * two fact sets.
     */
    @Test
    fun `a draft that turned dirty before the blur is kept, never adopted over`() = runBlocking {
        val log = mutableListOf<String>()
        val session = EditorSession(scope())
        var draft = "base"
        val effects = object : OpenNoteEffects {
            override fun currentNoteId(): String = "note"

            override fun isCurrentEditor(): Boolean = true

            override suspend fun gatherFacts(noteId: String): OpenNoteFacts {
                log += "facts:draft=$draft"
                return OpenNoteFacts(
                    base = "base",
                    draft = draft,
                    disk = "peer",
                    renamedTo = null,
                    // The deferral is taken while focused; the settle
                    // re-gathers after the blur.
                    editorFocused = draft == "base",
                    editedDuringCycle = false,
                )
            }

            override fun classify(facts: OpenNoteFacts): OpenNoteDisposition = when {
                facts.draft != facts.base ->
                    OpenNoteDisposition.KeepDraft(facts.disk!!, KeepDraftReason.DIVERGED)

                facts.editorFocused -> OpenNoteDisposition.DeferAdopt
                else -> OpenNoteDisposition.Adopt(facts.disk!!)
            }

            override fun resumeDraftPersistence() {
                log += "resume-draft"
            }

            override fun apply(
                noteId: String,
                disposition: OpenNoteDisposition,
            ) {
                log += "apply:${disposition::class.simpleName}"
                if (disposition is OpenNoteDisposition.KeepDraft) log += "rebase:${disposition.base}"
            }
        }

        session.reconcileOpenNote(effects)
        // The user typed after the deferral was taken, then blurred.
        draft = "mine"
        session.settleDeferredAdoption(effects)

        assertEquals(
            listOf(
                "facts:draft=base",
                "apply:DeferAdopt",
                "facts:draft=mine",
                "apply:KeepDraft",
                "rebase:peer",
            ),
            log,
        )
    }

    @Test
    fun `every rename target is classified even when the summary omits the target`() =
        runBlocking {
            val log = mutableListOf<String>()
            val session = EditorSession(scope())
            val effects = RecordingOpenNoteEffects(
                dispositions = ArrayDeque(
                    listOf(
                        OpenNoteDisposition.FollowRename("renamed"),
                        OpenNoteDisposition.Adopt("peer target"),
                    ),
                ),
                log = log,
            )

            session.reconcileOpenNote(effects)

            assertEquals(
                listOf(
                    "facts:note",
                    "classify",
                    "apply:note:FollowRename",
                    "facts:renamed",
                    "classify",
                    "apply:renamed:Adopt",
                ),
                log,
            )
        }

    @Test
    fun `rename cycles stop after each identity is seen once`() = runBlocking {
        val log = mutableListOf<String>()
        val effects = RecordingOpenNoteEffects(
            dispositions = ArrayDeque(
                listOf(
                    OpenNoteDisposition.FollowRename("renamed"),
                    OpenNoteDisposition.FollowRename("note"),
                ),
            ),
            log = log,
        )

        EditorSession(scope()).reconcileOpenNote(effects)

        assertEquals(2, log.count { it.startsWith("facts:") })
        assertEquals(2, log.count { it == "classify" })
    }

    @Test
    fun `an identity change during fact gathering applies nothing`() = runBlocking {
        val log = mutableListOf<String>()
        lateinit var effects: RecordingOpenNoteEffects
        effects = RecordingOpenNoteEffects(
            dispositions = ArrayDeque(listOf(OpenNoteDisposition.Adopt("peer"))),
            log = log,
            duringFacts = { effects.noteId = "another-note" },
        )

        EditorSession(scope()).reconcileOpenNote(effects)

        assertEquals(listOf("facts:note"), log)
    }

    @Test
    fun `an outgoing editor attachment cannot adopt or close the incoming editor`() = runBlocking {
        listOf(
            OpenNoteDisposition.Adopt("outgoing bytes"),
            OpenNoteDisposition.Close,
        ).forEach { disposition ->
            var attached = true
            val log = mutableListOf<String>()
            val effects = RecordingOpenNoteEffects(
                dispositions = ArrayDeque(listOf(disposition)),
                log = log,
                duringFacts = { attached = false },
                isCurrentEditor = { attached },
            )
            val session = EditorSession(scope())

            session.reconcileOpenNote(effects)

            assertEquals(listOf("facts:note"), log)
            assertFalse(session.isClosing)
        }
    }

    @Test
    fun `a gather failure rearms draft persistence before reaching the error boundary`() =
        runBlocking {
            val failure = IllegalStateException("read failed")
            val log = mutableListOf<String>()
            val effects = RecordingOpenNoteEffects(
                dispositions = ArrayDeque(),
                log = log,
                gatherFailure = failure,
            )

            val caught = runCatching {
                EditorSession(scope()).reconcileOpenNote(effects)
            }.exceptionOrNull()

            assertSame(failure, caught)
            assertEquals(listOf("facts:note", "resume-draft"), log)
        }

    @Test
    fun `an admitted autosave completes its base update before a replacement runs`() =
        runBlocking {
            val session = EditorSession(scope())
            val admitted = CompletableDeferred<Unit>()
            val releaseWrite = CompletableDeferred<Unit>()
            val log = mutableListOf<String>()

            val first = launch {
                session.runAutosave {
                    admitted.complete(Unit)
                    releaseWrite.await()
                    log += "disk committed"
                    log += "base advanced"
                }
            }
            admitted.await()
            first.cancel()
            val replacement = launch {
                session.runAutosave {
                    log += "replacement read base"
                }
            }

            releaseWrite.complete(Unit)
            first.join()
            replacement.join()

            assertEquals(
                listOf("disk committed", "base advanced", "replacement read base"),
                log,
            )
        }

    @Test
    fun `edit protection starts at reconciliation rather than the prior sync completion`() {
        assertFalse(
            editedDuringOpenNoteGather(
                reconciliationStartVersion = 7,
                currentEditVersion = 7,
            ),
        )
        assertTrue(
            editedDuringOpenNoteGather(
                reconciliationStartVersion = 7,
                currentEditVersion = 8,
            ),
        )
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
