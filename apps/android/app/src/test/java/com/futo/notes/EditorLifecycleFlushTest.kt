package com.futo.notes

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Regression for the Android editor's unsaved-draft register (F5 lifecycle
 * flush + PKT-12 R5 derivation). The open editor publishes its unsaved draft so
 * MainActivity.onPause can flush it before the OS jetsams a backgrounded
 * process; PKT-12 makes that register DERIVED (one snapshotFlow) and
 * OWNER-AWARE (a generation token per editor instance) so the PKT-1 races
 * (R1-R4) die by construction rather than by ~7 hand-synced set/clear sites.
 *
 * These pin the extracted, FFI-free register ([PendingEditorDraft]) — the only
 * piece testable without a device (apps/android ships JUnit only, and the
 * FFI-backed NotesStore can't be constructed in a JVM test). The snapshotFlow
 * wiring, AnimatedContent cross-fade overlap timing, and the on-disk
 * compare-and-swap write are covered by device QA.
 */
class EditorLifecycleFlushTest {
    /** Records every draft a flush would persist — stands in for the
     *  fire-and-forget NotesStore.flushAsync the production seam is wired to. */
    private class Recorder {
        val writes = mutableListOf<PendingDraft>()
        fun persist(draft: PendingDraft) { writes.add(draft) }
    }

    private fun draft(id: String, content: String) = PendingDraft(id, base = "", content = content)

    // ── derivation: flush persists the owner's current draft ──

    @Test
    fun flushesOwnersDerivedDraft() {
        val rec = Recorder()
        val pending = PendingEditorDraft(rec::persist)
        val token = pending.claim()
        pending.update(token, draft("todo", "buy milk"))
        pending.flush()
        assertEquals(listOf(draft("todo", "buy milk")), rec.writes)
    }

    @Test
    fun cleanOrClosedEditorFlushesNothing() {
        val rec = Recorder()
        val pending = PendingEditorDraft(rec::persist)
        // No editor ever claimed / published → no-op.
        pending.flush()
        // The derivation emitted null (body clean) → no-op.
        val token = pending.claim()
        pending.update(token, draft("todo", "buy milk"))
        pending.update(token, null)
        pending.flush()
        assertTrue(rec.writes.isEmpty())
    }

    @Test
    fun flushIsIdempotent() {
        val rec = Recorder()
        val pending = PendingEditorDraft(rec::persist)
        val token = pending.claim()
        pending.update(token, draft("todo", "buy milk"))
        // onPause then a repeated leave-foreground signal must not corrupt or
        // drop the write — the same draft is safe to persist twice.
        pending.flush()
        pending.flush()
        assertEquals(listOf(draft("todo", "buy milk"), draft("todo", "buy milk")), rec.writes)
    }

    @Test
    fun flushUsesLatestDerivedDraft() {
        val rec = Recorder()
        val pending = PendingEditorDraft(rec::persist)
        val token = pending.claim()
        // Each keystroke re-derives; a leave-foreground flush persists the
        // newest content, not a stale one.
        pending.update(token, draft("todo", "b"))
        pending.update(token, draft("todo", "buy"))
        pending.update(token, draft("todo", "buy milk"))
        pending.flush()
        assertEquals(listOf(draft("todo", "buy milk")), rec.writes)
    }

    // ── ownership: the cross-fade overlap can't drop the incoming draft (R2) ──

    @Test
    fun claimIssuesDistinctTokens() {
        val pending = PendingEditorDraft {}
        assertNotEquals(pending.claim(), pending.claim())
    }

    @Test
    fun supersededEditorUpdateIsNoOp() {
        val rec = Recorder()
        val pending = PendingEditorDraft(rec::persist)
        val outgoing = pending.claim()
        pending.update(outgoing, draft("todo", "old note"))
        // The incoming editor composes (AnimatedContent overlap) and claims.
        val incoming = pending.claim()
        pending.update(incoming, draft("groceries", "eggs"))
        // The outgoing editor's derivation fires once more before it disposes —
        // it must NOT clobber the incoming editor's draft.
        pending.update(outgoing, draft("todo", "old note edited"))
        pending.flush()
        assertEquals(listOf(draft("groceries", "eggs")), rec.writes)
    }

    @Test
    fun supersededEditorReleaseIsNoOp() {
        val rec = Recorder()
        val pending = PendingEditorDraft(rec::persist)
        val outgoing = pending.claim()
        val incoming = pending.claim()
        pending.update(incoming, draft("groceries", "eggs"))
        // The outgoing editor disposes AFTER the incoming one claimed — its
        // release must not wipe the incoming editor's just-derived draft (R2).
        pending.release(outgoing)
        pending.flush()
        assertEquals(listOf(draft("groceries", "eggs")), rec.writes)
    }

    @Test
    fun ownerReleaseClearsTheRegister() {
        val rec = Recorder()
        val pending = PendingEditorDraft(rec::persist)
        val token = pending.claim()
        pending.update(token, draft("todo", "buy milk"))
        // The only/last editor left composition (true pop) → register clears, so
        // a later background flush is a no-op.
        pending.release(token)
        pending.flush()
        assertTrue(rec.writes.isEmpty())
    }

    // ── base is carried for the compare-and-swap flush (PKT-12 item 3/4) ──

    @Test
    fun flushCarriesTheCompareAndSwapBase() {
        val rec = Recorder()
        val pending = PendingEditorDraft(rec::persist)
        val token = pending.claim()
        pending.update(token, PendingDraft("todo", base = "saved v1", content = "edited v2"))
        pending.flush()
        assertEquals("saved v1", rec.writes.single().base)
        assertEquals("edited v2", rec.writes.single().content)
    }
}
