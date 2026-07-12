package com.futo.notes

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Regression for F5 (Android lifecycle flush): the editor's 400 ms autosave
 * debounce had no leave-foreground flush, so an edit caught inside the debounce
 * window was lost when the OS killed the backgrounded process (or the user
 * swiped the app away). The fix mirrors the iOS F8 jetsam guard [editor.md]:
 * the open editor publishes its unsaved draft on every keystroke and
 * MainActivity.onPause flushes it via NotesStore.flushPendingEditor.
 *
 * These pin the extracted, FFI-free register/flush decision ([PendingEditorDraft])
 * — the only piece testable without a device (apps/android ships JUnit only, and
 * the FFI-backed NotesStore can't be constructed in a JVM test). The lifecycle
 * wiring (onPause → flushPendingEditor) and the on-disk write are covered by
 * device QA.
 */
class EditorLifecycleFlushTest {
    /** Records every (id, content) a flush would persist — stands in for the
     *  fire-and-forget NotesStore.flushAsync the production seam is wired to. */
    private class Recorder {
        val writes = mutableListOf<PendingDraft>()
        fun persist(id: String, content: String) { writes.add(PendingDraft(id, content)) }
    }

    @Test
    fun flushesPublishedDirtyDraft() {
        val rec = Recorder()
        val pending = PendingEditorDraft(rec::persist)
        pending.set(PendingDraft("todo", "buy milk"))
        pending.flush()
        assertEquals(listOf(PendingDraft("todo", "buy milk")), rec.writes)
    }

    @Test
    fun cleanOrClosedEditorFlushesNothing() {
        val rec = Recorder()
        val pending = PendingEditorDraft(rec::persist)
        // No editor ever published a draft → no-op.
        pending.flush()
        // Editor published a draft then went clean/closed (null) → no-op.
        pending.set(PendingDraft("todo", "buy milk"))
        pending.set(null)
        pending.flush()
        assertTrue(rec.writes.isEmpty())
    }

    @Test
    fun flushIsIdempotent() {
        val rec = Recorder()
        val pending = PendingEditorDraft(rec::persist)
        pending.set(PendingDraft("todo", "buy milk"))
        // onPause then a repeated leave-foreground signal must not corrupt or
        // drop the write — the same draft is safe to persist twice.
        pending.flush()
        pending.flush()
        assertEquals(
            listOf(PendingDraft("todo", "buy milk"), PendingDraft("todo", "buy milk")),
            rec.writes,
        )
    }

    @Test
    fun flushUsesLatestPublishedDraft() {
        val rec = Recorder()
        val pending = PendingEditorDraft(rec::persist)
        // Each keystroke republishes; a leave-foreground flush persists the
        // newest content, not a stale one.
        pending.set(PendingDraft("todo", "b"))
        pending.set(PendingDraft("todo", "buy"))
        pending.set(PendingDraft("todo", "buy milk"))
        pending.flush()
        assertEquals(listOf(PendingDraft("todo", "buy milk")), rec.writes)
    }

    // ── clearIf: compare-and-clear after a completed save ──

    @Test
    fun clearIfClearsExactMatch() {
        val rec = Recorder()
        val pending = PendingEditorDraft(rec::persist)
        // A debounced save completes and clears the draft it persisted → the
        // register is clean, so a later background flush is a no-op (no spurious
        // rewrite / mtime bump / sync push).
        pending.set(PendingDraft("todo", "buy milk"))
        pending.clearIf(PendingDraft("todo", "buy milk"))
        pending.flush()
        assertTrue(rec.writes.isEmpty())
    }

    @Test
    fun clearIfKeepsNewerDraftPublishedMidWrite() {
        val rec = Recorder()
        val pending = PendingEditorDraft(rec::persist)
        // A keystroke republished a newer draft while the write was suspended;
        // the completing save must NOT wipe it — a background flush persists the
        // newest content, not the stale save target.
        pending.set(PendingDraft("todo", "buy milk and eggs"))
        pending.clearIf(PendingDraft("todo", "buy milk")) // stale save target
        pending.flush()
        assertEquals(listOf(PendingDraft("todo", "buy milk and eggs")), rec.writes)
    }

    @Test
    fun clearIfIgnoresContentMismatchAtSameId() {
        val rec = Recorder()
        val pending = PendingEditorDraft(rec::persist)
        // Same note id, different content → not an exact match → not cleared.
        pending.set(PendingDraft("todo", "v2"))
        pending.clearIf(PendingDraft("todo", "v1"))
        pending.flush()
        assertEquals(listOf(PendingDraft("todo", "v2")), rec.writes)
    }

    // ── clearIfNoteId: id-guarded clear on dispose / remote-adopt ──

    @Test
    fun clearIfNoteIdClearsMatchingNote() {
        val rec = Recorder()
        val pending = PendingEditorDraft(rec::persist)
        pending.set(PendingDraft("todo", "buy milk"))
        pending.clearIfNoteId("todo")
        pending.flush()
        assertTrue(rec.writes.isEmpty())
    }

    @Test
    fun clearIfNoteIdKeepsOtherNotesDraft() {
        val rec = Recorder()
        val pending = PendingEditorDraft(rec::persist)
        // AnimatedContent cross-fade overlap: the next screen already published
        // note "groceries"'s draft; the disposing screen (note "todo") must not
        // wipe it.
        pending.set(PendingDraft("groceries", "eggs"))
        pending.clearIfNoteId("todo")
        pending.flush()
        assertEquals(listOf(PendingDraft("groceries", "eggs")), rec.writes)
    }
}
