package com.futo.notes

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import uniffi.futo_notes_ffi.SyncFailure
import uniffi.futo_notes_ffi.WriteRefusal

/**
 * Pins [SyncManager.applyOutcome], the single reporter for a completed
 * cycle's outcome [sync.md]: a clean cycle reports "Sync complete" and clears
 * the error line; a cycle with per-item failures routes the Rust-computed
 * `failureMessage` to the error line VERBATIM — the shell must not re-derive
 * or reword it, that's what keeps all three apps' wording identical.
 */
class SyncManagerOutcomeTest {
    private fun summary(
        failures: List<SyncFailure> = emptyList(),
        failureMessage: String? = null,
        writeRefusal: WriteRefusal? = null,
    ) = syncSummary(
        failures = failures,
        failureMessage = failureMessage,
        writeRefusal = writeRefusal,
    )

    @Test
    fun cleanCycleReportsSyncCompleteAndClearsError() {
        val mgr = SyncManager()
        mgr.applyOutcome(
            summary(
                failures = listOf(SyncFailure("a.md", "upload", 500u.toUShort())),
                failureMessage = "1 change couldn't reach the server (HTTP 500)",
            ),
        )
        mgr.applyOutcome(summary())
        assertEquals("sync.status.complete", mgr.statusMessage.path)
        assertNull(mgr.lastErrorDiagnostic)
    }

    @Test
    fun failingCycleRoutesRustMessageToErrorLineVerbatim() {
        val mgr = SyncManager()
        val message = "2 changes couldn't reach the server (HTTP 500); sync state couldn't be saved locally"
        mgr.applyOutcome(
            summary(
                failures = listOf(
                    SyncFailure("a.md", "upload", 500u.toUShort()),
                    SyncFailure("", "checkpoint", null),
                ),
                failureMessage = message,
            ),
        )
        assertEquals("sync.status.error", mgr.statusMessage.path)
        assertEquals(message, mgr.lastErrorDiagnostic)
    }

    /**
     * A refused write is the one failure that is not a fault: nothing is
     * broken, the account simply may not write. "Sync completed with errors"
     * sent people looking for a server problem that was not there, so the
     * status line says what actually happened wherever the person is
     * (ADR 0003 decision 8). Rust names the refusal; the shell picks the words.
     */
    @Test
    fun refusedWriteSaysSyncPausedRatherThanThatSyncBroke() {
        val mgr = SyncManager()
        mgr.applyOutcome(
            summary(
                failures = listOf(SyncFailure("a.md", "upload", 402u.toUShort())),
                failureMessage = "1 change couldn't reach the server (HTTP 402)",
                writeRefusal = WriteRefusal.SUBSCRIPTION_REQUIRED,
            ),
        )
        assertEquals("sync.hosted.banner.syncPaused.title", mgr.statusMessage.path)
        assertEquals(WriteRefusal.SUBSCRIPTION_REQUIRED, mgr.lastWriteRefusal)
    }

    @Test
    fun fullVaultSaysSoAndIsClearedByTheNextCleanCycle() {
        val mgr = SyncManager()
        mgr.applyOutcome(
            summary(
                failures = listOf(SyncFailure("a.md", "upload", 507u.toUShort())),
                failureMessage = "1 change couldn't reach the server (HTTP 507)",
                writeRefusal = WriteRefusal.QUOTA_EXCEEDED,
            ),
        )
        assertEquals("sync.hosted.banner.vaultFull.title", mgr.statusMessage.path)
        assertEquals(WriteRefusal.QUOTA_EXCEEDED, mgr.lastWriteRefusal)

        // Never a latch: buying room clears the banner on its own.
        mgr.applyOutcome(summary())
        assertEquals("sync.status.complete", mgr.statusMessage.path)
        assertNull(mgr.lastWriteRefusal)
    }

    @Test
    fun writeRefusalWordingIsTheSameCatalogEntryEveryShellReads() {
        assertEquals(
            "sync.errors.writePausedSubscription",
            SyncManager.writeRefusalExplanation(WriteRefusal.SUBSCRIPTION_REQUIRED),
        )
        assertEquals(
            "sync.errors.writePausedQuota",
            SyncManager.writeRefusalExplanation(WriteRefusal.QUOTA_EXCEEDED),
        )
    }
}
