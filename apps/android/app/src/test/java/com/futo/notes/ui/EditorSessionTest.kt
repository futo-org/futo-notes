package com.futo.notes.ui

import com.futo.notes.ui.SessionScope.scope
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
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
                "current",
                "facts:note",
                "classify",
                "apply:note:DeferAdopt",
                "current",
                "facts:note",
                "classify",
                "apply:note:Adopt",
            ),
            log,
        )
    }

    /**
     * The blur edge is not synchronized with the cycle that produces the
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
                "current",
                "facts:note",
                "classify",
                "apply:note:DeferAdopt",
                "current",
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

            override suspend fun awaitCurrent(): EditorCurrent =
                EditorCurrent(DocumentSnapshot(1, draft), false)

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

            override suspend fun apply(
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
                    "current",
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

        assertEquals(listOf("current", "facts:note"), log)
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

            assertEquals(listOf("current", "facts:note"), log)
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
            assertEquals(listOf("current", "facts:note", "resume-draft"), log)
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
}
