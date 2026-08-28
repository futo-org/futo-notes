package com.futo.notes

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import uniffi.futo_notes_ffi.SyncFailure

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
    ) = syncSummary(failures = failures, failureMessage = failureMessage)

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
}
