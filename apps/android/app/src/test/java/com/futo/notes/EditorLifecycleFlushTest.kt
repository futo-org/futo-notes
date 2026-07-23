package com.futo.notes

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import uniffi.futo_notes_ffi.FlushDisposition

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

    @Test
    fun conflictAdoptionReloadsOnlyAfterTheEngineParksTheDraft() {
        assertEquals(
            AdoptFlushOutcome.RELOAD_DISK,
            adoptFlushOutcome(FlushDisposition.ParkedConflict("parked")),
        )
        assertEquals(
            AdoptFlushOutcome.RETRY_LATER,
            adoptFlushOutcome(null),
        )
    }

    @Test
    fun conflictAdoptionKeepsDraftForEveryEngineOutcomeThatOwnsTheOriginalId() {
        listOf(
            FlushDisposition.Wrote,
            FlushDisposition.Converged,
            FlushDisposition.Recreated,
        ).forEach { disposition ->
            assertEquals(AdoptFlushOutcome.KEEP_DRAFT, adoptFlushOutcome(disposition))
        }
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

    /**
     * PKT-12 round-3 P2: two editors overlapping on the SAME note during a
     * cross-fade (rename + self-link nav, both dirty) must not fire two
     * conditional writes that read the same base and race. flush() coalesces by
     * note id → exactly one dispatch, carrying the LAST-registered provider's
     * content (the incoming editor is the user's current view).
     */
    @Test
    fun sameNoteIdCoalescesToLastRegisteredProvider() {
        val rec = Recorder()
        val pending = PendingEditorDraft(rec::persist)
        val first = pending.claim()
        val firstState = EditorState(noteId = "note", savedContent = "base", content = "base + first")
        pending.setProvider(first, firstState::derive)
        val second = pending.claim()
        val secondState = EditorState(noteId = "note", savedContent = "base", content = "base + second")
        pending.setProvider(second, secondState::derive)
        pending.flush()
        assertEquals(
            "exactly one flush per note, carrying the later-registered content",
            listOf(PendingDraft("note", "base", "base + second")),
            rec.writes,
        )
    }

    @Test
    fun releaseRetainsItsDirtyDraftWithoutTouchingAnotherOwner() {
        val rec = Recorder()
        val pending = PendingEditorDraft(rec::persist)
        val a = pending.claim()
        val aState = EditorState(noteId = "a", savedContent = "", content = "edit A")
        pending.setProvider(a, aState::derive)
        val b = pending.claim()
        val bState = EditorState(noteId = "b", savedContent = "", content = "edit B")
        pending.setProvider(b, bState::derive)
        // A disposes; its dirty draft is retained and B stays live.
        pending.release(a)
        pending.flush()
        assertEquals(
            listOf(
                PendingDraft("a", "", "edit A"),
                PendingDraft("b", "", "edit B"),
            ),
            rec.writes,
        )
    }

    @Test
    fun lastEditorReleaseClearsTheRegister() {
        val rec = Recorder()
        val pending = PendingEditorDraft(rec::persist)
        val token = pending.claim()
        val st = EditorState(savedContent = "saved", content = "saved")
        pending.setProvider(token, st::derive)
        // The only/last editor left composition (true pop) → entry removed, so a
        // later background flush is a no-op.
        pending.release(token)
        pending.flush()
        assertTrue(rec.writes.isEmpty())
    }

    @Test
    fun completedRetainedDraftIsNotRetried() {
        val rec = Recorder()
        val pending = PendingEditorDraft(rec::persist)
        val token = pending.claim()
        val draft = PendingDraft("todo", "saved", "saved + edit")
        pending.setProvider(token) { draft }
        pending.release(token)
        pending.complete(draft)

        pending.flush()

        assertTrue(rec.writes.isEmpty())
    }

    @Test
    fun newerCommittedSaveSupersedesOlderRetainedDraftForSameNote() {
        val rec = Recorder()
        val pending = PendingEditorDraft(rec::persist)
        val token = pending.claim()
        pending.setProvider(token) {
            PendingDraft("todo", "old base", "older unsaved edit")
        }
        pending.release(token)

        val admitted = pending.retainedSnapshot("todo")
        pending.completeSnapshot(admitted)
        pending.flush()

        assertTrue(
            "a newer committed save must prevent the stale leave snapshot from parking later",
            rec.writes.isEmpty(),
        )
    }

    @Test
    fun ordinarySaveDoesNotClearAnewerRetainedDraft() {
        val rec = Recorder()
        val pending = PendingEditorDraft(rec::persist)
        val oldToken = pending.claim()
        pending.setProvider(oldToken) { PendingDraft("todo", "A", "old") }
        pending.release(oldToken)
        val admitted = pending.retainedSnapshot("todo")

        val newToken = pending.claim()
        pending.setProvider(newToken) { PendingDraft("todo", "A", "new") }
        pending.release(newToken)
        pending.completeSnapshot(admitted)
        pending.flush()

        assertEquals(listOf(PendingDraft("todo", "A", "new")), rec.writes)
    }

    @Test
    fun identityMutationRetargetsRetainedDraftToAuthoritativeFinalId() {
        val rec = Recorder()
        val pending = PendingEditorDraft(rec::persist)
        val token = pending.claim()
        pending.setProvider(token) { PendingDraft("old", "A", "draft") }
        pending.release(token)

        pending.retargetRetainedNote("old", "folder/final-2")
        pending.flush()

        assertEquals(
            listOf(PendingDraft("folder/final-2", "A", "draft")),
            rec.writes,
        )
    }

    @Test
    fun committedDeleteDiscardsLiveAndRetainedDrafts() {
        val rec = Recorder()
        val pending = PendingEditorDraft(rec::persist)
        val retainedToken = pending.claim()
        pending.setProvider(retainedToken) { PendingDraft("note", "A", "retained") }
        pending.release(retainedToken)
        pending.setProvider(pending.claim()) { PendingDraft("note", "A", "live") }

        pending.discardNote("note")
        pending.flush()

        assertTrue(rec.writes.isEmpty())
    }

    @Test
    fun dirtyEditorReleaseRetainsItsDraftForLifecycleRetry() {
        val rec = Recorder()
        val pending = PendingEditorDraft(rec::persist)
        val token = pending.claim()
        val state = EditorState(
            noteId = "todo",
            savedContent = "saved",
            content = "saved + unsaved",
        )
        pending.setProvider(token, state::derive)

        // Navigation disposes the editor before the asynchronous leave flush can
        // prove durability. A later lifecycle flush must still see the draft.
        pending.release(token)
        pending.flush()

        assertEquals(
            listOf(PendingDraft("todo", "saved", "saved + unsaved")),
            rec.writes,
        )
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
