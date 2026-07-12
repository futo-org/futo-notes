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
     *  closure reads it through the REAL derivation ([derivePendingDraft]),
     *  exactly as the production provider closure does. */
    private class EditorState(
        var loaded: Boolean = true,
        var noteId: String = "todo",
        var savedContent: String = "",
        var content: String = "",
    ) {
        fun derive(): PendingDraft? = derivePendingDraft(loaded, noteId, savedContent, content)
    }

    // ── the derivation predicate itself (single source of truth) ──

    @Test
    fun derivationIsDirtyWhenContentDivergesFromSaved() {
        assertEquals(
            PendingDraft("todo", "saved", "saved + edit"),
            derivePendingDraft(loaded = true, noteId = "todo", savedContent = "saved", content = "saved + edit"),
        )
    }

    @Test
    fun derivationIsNullWhenCleanOrNotLoaded() {
        // Clean: content == savedContent.
        assertNull(derivePendingDraft(loaded = true, noteId = "todo", savedContent = "x", content = "x"))
        // Not yet loaded: the WebView's empty mount echo must never look dirty.
        assertNull(derivePendingDraft(loaded = false, noteId = "todo", savedContent = "", content = "typed"))
    }

    @Test
    fun derivationReKeysToTheLiveNoteIdAfterRename() {
        // After a rename the composable's noteId state changes; the derivation
        // follows it, so a dirty draft is keyed on the NEW id (PKT-1 R4 / item 2b).
        assertEquals(
            "renamed",
            derivePendingDraft(loaded = true, noteId = "renamed", savedContent = "A", content = "AB")!!.id,
        )
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

    /**
     * PKT-12 G1: the cross-fade must not evict the outgoing dirty editor. A
     * wikilink opens editor B while dirty editor A is still composed in
     * AnimatedContent; B registers its provider while unloaded (derives null). A
     * pause+kill before A's dispose must still flush A's edit. A single-slot
     * register would have let B's registration evict A's provider and lose it.
     */
    @Test
    fun crossFadeFlushesOutgoingDirtyEditor() {
        val rec = Recorder()
        val pending = PendingEditorDraft(rec::persist)
        // Editor A: dirty, still composed.
        val a = pending.claim()
        val aState = EditorState(noteId = "todo", savedContent = "saved", content = "saved + dirty")
        pending.setProvider(a, aState::derive)
        // Editor B: just opened via a wikilink, not loaded yet → derives null.
        val b = pending.claim()
        val bState = EditorState(loaded = false, noteId = "groceries", savedContent = "", content = "")
        pending.setProvider(b, bState::derive)
        // Background+kill before A disposes.
        pending.flush()
        assertEquals(
            "A's dirty edit must survive the cross-fade (single-slot would lose it)",
            listOf(PendingDraft("todo", "saved", "saved + dirty")),
            rec.writes,
        )
    }

    @Test
    fun releaseRemovesOnlyItsOwnEntry() {
        val rec = Recorder()
        val pending = PendingEditorDraft(rec::persist)
        val a = pending.claim()
        val aState = EditorState(noteId = "a", savedContent = "", content = "edit A")
        pending.setProvider(a, aState::derive)
        val b = pending.claim()
        val bState = EditorState(noteId = "b", savedContent = "", content = "edit B")
        pending.setProvider(b, bState::derive)
        // A disposes; its release must not touch B's entry.
        pending.release(a)
        pending.flush()
        assertEquals(listOf(PendingDraft("b", "", "edit B")), rec.writes)
    }

    @Test
    fun lastEditorReleaseClearsTheRegister() {
        val rec = Recorder()
        val pending = PendingEditorDraft(rec::persist)
        val token = pending.claim()
        val st = EditorState(savedContent = "", content = "buy milk")
        pending.setProvider(token, st::derive)
        // The only/last editor left composition (true pop) → entry removed, so a
        // later background flush is a no-op.
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
