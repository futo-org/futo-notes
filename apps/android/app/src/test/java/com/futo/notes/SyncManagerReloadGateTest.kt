package com.futo.notes

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import uniffi.futo_notes_ffi.SyncSummary

/**
 * Regression for F2: the native editor-reload gate ([SyncManager.wroteLocalChanges])
 * must fire on a PUSH-side clean merge. A `MergedClean` writes the merged text
 * to local disk but reports it as `uploaded` — `downloaded`/`deleted` stay 0.
 * The old gate (`downloaded > 0 || deleted > 0`) treated that as a no-op, so a
 * stale open editor never reloaded and its next autosave silently clobbered the
 * peer's merged-in edit. The core now surfaces the write in `localWritesApplied`;
 * the gate must honor it.
 */
class SyncManagerReloadGateTest {
    private fun summary(
        downloaded: UInt = 0u,
        deleted: UInt = 0u,
        uploaded: UInt = 0u,
        localWritesApplied: UInt = 0u,
    ) = SyncSummary(
        uploaded = uploaded,
        downloaded = downloaded,
        deleted = deleted,
        conflicts = 0u,
        localWritesApplied = localWritesApplied,
        failures = emptyList(),
        failureMessage = null,
    )

    @Test
    fun pushSideMergeReloadsEvenWithNoDownloadsOrDeletes() {
        // The F2 bug fingerprint: a clean merge bumped `uploaded` only.
        val merge = summary(uploaded = 1u, localWritesApplied = 1u)
        assertTrue(SyncManager.wroteLocalChanges(merge))
    }

    @Test
    fun noOpCycleDoesNotReload() {
        assertFalse(SyncManager.wroteLocalChanges(summary()))
        // A pure upload with no local write is still a no-op for the editor.
        assertFalse(SyncManager.wroteLocalChanges(summary(uploaded = 3u)))
    }

    @Test
    fun peerDownloadsAndDeletesStillReload() {
        assertTrue(SyncManager.wroteLocalChanges(summary(downloaded = 1u)))
        assertTrue(SyncManager.wroteLocalChanges(summary(deleted = 1u)))
    }
}
