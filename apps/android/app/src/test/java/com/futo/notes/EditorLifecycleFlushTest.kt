package com.futo.notes

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Regression for the Android editor's unsaved-draft register (F5 lifecycle
 * flush + PKT-12 R5 derivation). The open editor publishes its unsaved draft so
 * MainActivity.onPause can flush it before the OS jetsams a backgrounded
 * process; PKT-12 makes that register DERIVED + PULL-based (one derivation
 * closure, invoked synchronously at flush) and OWNER-AWARE (a generation token
 * per editor instance) so the PKT-1 races (R1-R4) die by construction rather
 * than by ~7 hand-synced set/clear sites.
 *
 * These pin the extracted, FFI-free register ([PendingEditorDraft]) — the only
 * piece testable without a device (apps/android ships JUnit only, and the
 * FFI-backed NotesStore can't be constructed in a JVM test). The AnimatedContent
 * cross-fade overlap timing and the on-disk conditional write are covered by
 * device QA.
 */
class EditorLifecycleFlushTest {
    /** Records every draft a flush would persist — stands in for the
     *  fire-and-forget NotesStore.flushAsync the production seam is wired to. */
    private class Recorder {
        val writes = mutableListOf<PendingDraft>()
        fun persist(draft: PendingDraft) { writes.add(draft) }
    }

    /** A mutable stand-in for the editor's live Compose state; the provider
     *  closure reads it, exactly as the real derivation reads (loaded, noteId,
     *  content, savedContent). */
    private class EditorState(
        var loaded: Boolean = true,
        var noteId: String = "todo",
        var savedContent: String = "",
        var content: String = "",
    ) {
        fun derive(): PendingDraft? =
            if (loaded && content != savedContent) PendingDraft(noteId, savedContent, content) else null
    }

    // ── pull derivation: flush persists whatever the closure derives NOW ──

    @Test
    fun flushPullsOwnersDerivedDraft() {
        val rec = Recorder()
        val pending = PendingEditorDraft(rec::persist)
        val st = EditorState(savedContent = "", content = "buy milk")
        val token = pending.claim()
        pending.setProvider(token, st::derive)
        pending.flush()
        assertEquals(listOf(PendingDraft("todo", "", "buy milk")), rec.writes)
    }

    @Test
    fun cleanOrClosedEditorFlushesNothing() {
        val rec = Recorder()
        val pending = PendingEditorDraft(rec::persist)
        // No provider registered → no-op.
        pending.flush()
        // Provider registered but the body is clean (content == savedContent) → no-op.
        val st = EditorState(savedContent = "same", content = "same")
        pending.setProvider(pending.claim(), st::derive)
        pending.flush()
        assertTrue(rec.writes.isEmpty())
    }

    /**
     * PKT-12 F2 (the fix's core): the provider is pulled SYNCHRONOUSLY at flush
     * time, so a keystroke landing immediately before the flush is persisted —
     * there is no async publication window where the register lags the editor.
     * Under the old push register, a draft published asynchronously could be
     * stale when onPause ran; here the flush reads live state on demand.
     */
    @Test
    fun flushSeesTheStateAtFlushTimeNotAtRegistration() {
        val rec = Recorder()
        val pending = PendingEditorDraft(rec::persist)
        val st = EditorState(savedContent = "v0", content = "v0")
        val token = pending.claim()
        pending.setProvider(token, st::derive)
        // A keystroke lands AFTER registration, immediately before the flush.
        st.content = "v0 + newest keystroke"
        pending.flush()
        assertEquals(
            listOf(PendingDraft("todo", "v0", "v0 + newest keystroke")),
            rec.writes,
        )
    }

    // ── ownership: the cross-fade overlap can't drop the incoming provider (R2) ──

    @Test
    fun claimIssuesDistinctTokens() {
        val pending = PendingEditorDraft {}
        assertNotEquals(pending.claim(), pending.claim())
    }

    @Test
    fun supersededEditorSetProviderIsNoOp() {
        val rec = Recorder()
        val pending = PendingEditorDraft(rec::persist)
        val outgoing = pending.claim()
        val outgoingState = EditorState(noteId = "todo", savedContent = "", content = "old note")
        pending.setProvider(outgoing, outgoingState::derive)
        // The incoming editor composes (AnimatedContent overlap) and claims.
        val incoming = pending.claim()
        val incomingState = EditorState(noteId = "groceries", savedContent = "", content = "eggs")
        pending.setProvider(incoming, incomingState::derive)
        // The outgoing editor's effect fires once more before it disposes — it
        // must NOT overwrite the incoming editor's provider.
        pending.setProvider(outgoing, outgoingState::derive)
        pending.flush()
        assertEquals(listOf(PendingDraft("groceries", "", "eggs")), rec.writes)
    }

    @Test
    fun supersededEditorReleaseIsNoOp() {
        val rec = Recorder()
        val pending = PendingEditorDraft(rec::persist)
        val outgoing = pending.claim()
        val incoming = pending.claim()
        val incomingState = EditorState(noteId = "groceries", savedContent = "", content = "eggs")
        pending.setProvider(incoming, incomingState::derive)
        // The outgoing editor disposes AFTER the incoming one claimed — its
        // release must not drop the incoming editor's provider (R2).
        pending.release(outgoing)
        pending.flush()
        assertEquals(listOf(PendingDraft("groceries", "", "eggs")), rec.writes)
    }

    @Test
    fun ownerReleaseClearsTheRegister() {
        val rec = Recorder()
        val pending = PendingEditorDraft(rec::persist)
        val token = pending.claim()
        val st = EditorState(savedContent = "", content = "buy milk")
        pending.setProvider(token, st::derive)
        // The only/last editor left composition (true pop) → provider dropped, so
        // a later background flush is a no-op.
        pending.release(token)
        pending.flush()
        assertTrue(rec.writes.isEmpty())
    }

    /**
     * PKT-12 F1: rename/move flush a body snapshot to the current id, then must
     * advance savedContent to THAT SNAPSHOT — never to live `content`. If the
     * user types during the suspended write, `content` runs ahead of the bytes on
     * disk; the register must stay dirty for that newer keystroke. This models the
     * fixed assignment (savedContent := writtenSnapshot) and asserts the pulled
     * draft is still dirty for the newer content; the buggy assignment
     * (savedContent := live content) would derive null (asserted below).
     */
    @Test
    fun renameFlushKeepsMidWriteKeystrokeDirty() {
        val rec = Recorder()
        val pending = PendingEditorDraft(rec::persist)
        val st = EditorState(noteId = "note", savedContent = "A", content = "A")
        pending.setProvider(pending.claim(), st::derive)

        // Rename flush: snapshot = current content ("A"), write it, savedContent := snapshot.
        val writtenSnapshot = st.content
        // ...user types "C" while the write is suspended...
        st.content = "AC"
        // FIXED assignment: savedContent becomes the written snapshot, not live content.
        st.savedContent = writtenSnapshot
        // Rename re-keys the note; the derivation follows the live id.
        st.noteId = "renamed"

        pending.flush()
        assertEquals(
            "the mid-write keystroke must survive on the re-keyed note",
            listOf(PendingDraft("renamed", "A", "AC")),
            rec.writes,
        )
    }

    @Test
    fun renameFlushBugWouldMarkMidWriteKeystrokeAsSaved() {
        // Documents the regression the fix prevents: had savedContent been set
        // from live `content` (the buggy assignment), the derivation would see
        // content == savedContent and drop the newer keystroke.
        val st = EditorState(noteId = "note", savedContent = "A", content = "A")
        st.content = "AC"             // mid-write keystroke
        st.savedContent = st.content  // BUG: assign from live content, not the snapshot
        assertNull("buggy assignment loses the keystroke", st.derive())
    }
}
