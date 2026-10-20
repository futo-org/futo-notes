package com.futo.notes.ui

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import uniffi.futo_notes_ffi.OpenNoteDisposition
import com.futo.notes.ui.SessionScope.scope
import com.futo.notes.ui.SessionScope.settle

/** Exits and flushes against the per-note mailbox and an in-flight reconcile, using the recording effects in EditorSessionTestDoubles.kt. */
class EditorSessionMailboxTest {
    @Test
    fun `editor changes are fenced before load, while closing, and during a storage migration`() {
        val session = EditorSession(scope())

        assertFalse(session.acceptsEditorChange(loaded = false, storageMigrationStarted = false))
        assertTrue(session.acceptsEditorChange(loaded = true, storageMigrationStarted = false))
        assertFalse(session.acceptsEditorChange(loaded = true, storageMigrationStarted = true))
    }
    @Test
    fun `Back does not wait for a wedged renderer during reconcile adoption`() = runBlocking {
        val scope = scope()
        val session = EditorSession(scope)
        val started = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        val log = mutableListOf<String>()
        val reconciliation = scope.launch {
            session.reconcileOpenNote(RecordingOpenNoteEffects(
                dispositions = ArrayDeque(listOf(OpenNoteDisposition.Adopt("peer"))),
                log = log,
                applyGate = { started.complete(Unit); release.await() },
            ))
        }
        started.await()
        val exited = CompletableDeferred<Unit>()
        session.end(EditorExit.NAVIGATE, RecordingEffects(log, performs = { exited.complete(Unit); true }))
        try { withTimeout(250) { exited.await() } }
        finally { release.complete(Unit); reconciliation.join(); scope.settle() }
        assertTrue(log.none { it == "apply:note:Adopt" })
    }

    @Test fun `Back cancels a pending reconcile mailbox wait`() = runBlocking {
        val scope = scope()
        val session = EditorSession(scope)
        val started = CompletableDeferred<Unit>()
        val log = mutableListOf<String>()
        val recording = RecordingOpenNoteEffects(dispositions = ArrayDeque(), log = log)
        val effects = object : OpenNoteEffects by recording {
            override suspend fun awaitCurrent(): EditorCurrent {
                started.complete(Unit)
                return CompletableDeferred<EditorCurrent>().await()
            }
        }
        val reconcile = scope.async { session.reconcileOpenNote(effects) }
        started.await()
        val nav = RecordingEffects(log)
        session.end(EditorExit.NAVIGATE, nav)
        withTimeout(250) { scope.settle() }
        assertTrue(nav.succeeded)
        assertNull(reconcile.await())
        assertFalse(log.contains("classify"))
    }

    @Test fun `an exit that stops short reruns its interrupted reconcile`() = runBlocking {
        val scope = scope()
        val session = EditorSession(scope)
        val started = CompletableDeferred<Unit>()
        val log = mutableListOf<String>()
        var waits = 0
        val recording = RecordingOpenNoteEffects(dispositions = ArrayDeque(listOf(OpenNoteDisposition.Leave)), log = log)
        val effects = object : OpenNoteEffects by recording {
            override suspend fun awaitCurrent(): EditorCurrent {
                if (++waits == 1) { started.complete(Unit); CompletableDeferred<Unit>().await() }
                return EditorCurrent(DocumentSnapshot(1, "draft"), false)
            }
        }
        scope.launch { session.reconcileOpenNote(effects) }
        started.await()
        var attached = true
        session.end(
            EditorExit.NAVIGATE,
            RecordingEffects(log, attached = { attached }, onPrepare = { attached = false }),
        )
        withTimeout(250) { scope.settle() }
        assertEquals(2, waits)
        assertEquals(1, log.count { it == "classify" })
        assertFalse(session.isInteractionLocked)
    }

    @Test fun `background flush waits for an admitted autosave to advance its base`() = runBlocking {
        val scope = scope()
        val session = EditorSession(scope)
        val started = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        var base = "before"
        val save = scope.async { session.runAutosave { started.complete(Unit); release.await(); base = "after" } }
        started.await()
        val log = mutableListOf<String>()
        val effects = RecordingOpenNoteEffects(dispositions = ArrayDeque(), log = log)
        val background = scope.async { session.flushPendingEditor(effects); base }
        assertFalse(background.isCompleted)
        release.complete(Unit)
        save.await()
        assertEquals("after", background.await())
        assertEquals(listOf("current"), log)
    }

    @Test fun `every exit uses latest mailbox bytes or refuses while behind`() = runBlocking {
        EditorExit.entries.forEach { exit ->
            listOf(false, true).forEach { gone ->
                val mailbox = EditorMailbox()
                mailbox.loaded("note", 1, "base")
                mailbox.edited("note", 2)
                if (gone) mailbox.rendererGone()
                val scope = scope()
                val session = EditorSession(scope)
                var committed: String? = null
                val effects = object : EditorExitEffects {
                    override suspend fun awaitCurrentBody(): String? {
                        val current = mailbox.awaitCurrent("note") { mailbox.failed("note", it) }
                        return if (current.canProceed) current.latest?.content else null
                    }
                    override suspend fun commitBody(body: String): Boolean { committed = body; return true }
                    override suspend fun perform() = true
                }
                session.end(exit, effects)
                scope.settle()
                assertEquals(if (gone) "base" else null, committed)
                // Navigation has already left; the others stay on the note.
                if (!gone && exit != EditorExit.NAVIGATE) {
                    assertFalse(session.isClosing || session.isInteractionLocked)
                }
            }
        }
    }

    @Test fun `background flush records a durable baseline before the next keystroke saves`() = runBlocking {
        val session = EditorSession(scope())
        var base = "base"
        var draft = "base typed"
        val writtenBases = mutableListOf<String>()
        val recording = RecordingOpenNoteEffects(dispositions = ArrayDeque(), log = mutableListOf())
        val effects = object : OpenNoteEffects by recording {
            override suspend fun persistDraft() {
                writtenBases += base
                base = draft
            }
        }
        session.flushPendingEditor(effects)
        draft += " more"
        session.runAutosave { effects.persistDraft() }
        assertEquals(listOf("base", "base typed"), writtenBases)
        assertEquals("base typed more", base)
    }
}
