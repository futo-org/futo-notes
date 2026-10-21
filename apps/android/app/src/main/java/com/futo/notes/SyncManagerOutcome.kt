package com.futo.notes

import com.futo.notes.localization.LocalizedMessage
import com.futo.notes.SyncManager.Companion.shouldHealLiveError
import com.futo.notes.SyncManager.Companion.writeRefusalExplanation
import com.futo.notes.SyncManager.Companion.writeRefusalHeadline
import com.futo.notes.SyncManager.Companion.wroteLocalChanges
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import uniffi.futo_notes_ffi.SyncException
import uniffi.futo_notes_ffi.SyncSummary

suspend fun SyncManager.syncNow() {
    storageMigrationGate.runAccessIfAvailable {
        val c = client ?: return@runAccessIfAvailable
        busy = true
        lastErrorDiagnostic = null
        errorMessage = null
        statusMessage = LocalizedMessage("sync.status.syncing")
        try {
            val summary = c.syncNow()
            applyOutcome(summary)
            if (wroteLocalChanges(summary)) onLocalTreeChanged?.invoke(summary)
        } catch (e: Exception) {
            // Re-login for both a collapsed vault and an expired bearer token.
            // The same-vault path keeps the persisted cursor/object map, so
            // token expiry does not trigger a full reconcile.
            if (isRecoverableSessionError(e)) {
                healSession(describe(e))
            } else {
                lastErrorDiagnostic = describe(e)
                statusMessage = LocalizedMessage("sync.status.error")
                errorMessage = failureMessage(e, "sync.errors.syncFailed")
            }
        } finally {
            busy = false
        }
    }
}

internal fun SyncManager.isRecoverableSessionError(e: Exception): Boolean =
    e is SyncException.Auth || e is SyncException.CollectionGone

internal fun SyncManager.failureMessage(e: Exception, fallbackPath: String): LocalizedMessage =
    if (isCertificateRejection(describe(e))) {
        LocalizedMessage("sync.errors.certificateNotTrusted")
    } else {
        LocalizedMessage(fallbackPath)
    }

/** rustls prefixes every certificate rejection this way, whatever the
 *  verifier's reason [sync.md]. */
internal fun SyncManager.isCertificateRejection(message: String): Boolean =
    message.contains("invalid peer certificate")

/** Re-login with the stored password to recover an expired session or
 *  collapsed vault without deleting state. Guarded against re-entry;
 *  mirrors iOS `healSession`. → sync.md */
internal fun SyncManager.healSession(fallbackMessage: String) {
    if (healing || storageMigrationGate.isMigrationStarted) return
    val root = notesRoot
    if (root == null) {
        reportUnavailableSessionRecovery(fallbackMessage)
        return
    }
    healing = true
    client?.stopLive()
    scope.launch {
        try {
            storageMigrationGate.runAccessIfAvailable {
                val password = withContext(Dispatchers.IO) {
                    runCatching { secure?.loadPassword() }.getOrNull()
                }
                // The dead session's live loop stopped itself; both branches
                // rebuild an authenticated client while still holding the
                // operation gate.
                if (password != null) {
                    connectAndSyncLocked(root, password)
                    return@runAccessIfAvailable
                }
                // A hosted session rebuilt from the same two secrets. A
                // token the server no longer accepts is a trip to the
                // browser, which Rust arranges by dropping it — the wizard
                // then answers SIGN_IN and the vault key stays where it is.
                val setup = makeHostedSetup(root)
                if (setup == null || !hasSavedVault(setup)) {
                    reportUnavailableSessionRecovery(fallbackMessage)
                    return@runAccessIfAvailable
                }
                connectHostedLocked(root, setup)
            }
        } finally {
            // Also release when migration began before this queued heal
            // acquired the operation gate, or when the task is canceled.
            healing = false
        }
    }
}

internal fun SyncManager.handleLiveError(message: String) {
    // Auth expiry and collection-gone are terminal for the old live loop,
    // but recoverable from the securely stored password.
    if (shouldHealLiveError(message)) {
        healSession(message)
    } else {
        lastErrorDiagnostic = message
        // A certificate rejection is reported as such whichever kind it
        // arrives as (connect, stream or cycle) [sync.md].
        errorMessage = LocalizedMessage(
            if (isCertificateRejection(message)) {
                "sync.errors.certificateNotTrusted"
            } else {
                "sync.errors.liveUnavailable"
            },
        )
    }
}

internal fun SyncManager.reportUnavailableSessionRecovery(message: String) {
    lastErrorDiagnostic = message
    statusMessage = LocalizedMessage("sync.status.error")
    errorMessage = LocalizedMessage("sync.errors.previousFailure")
}

/** Single reporter for a completed cycle's outcome [sync.md]: clean →
 *  "Sync complete" (no counts); per-item failures → the red error line,
 *  using `failureMessage` (computed in Rust as a diagnostic) to select the
 *  error state; visible wording comes from the shared catalog. Cleared by
 *  the next clean cycle. */
internal fun SyncManager.applyOutcome(summary: SyncSummary) {
    lastWriteRefusal = summary.writeRefusal
    val message = summary.failureMessage
    val refusal = summary.writeRefusal
    if (refusal != null) {
        // A refused write is the one failure that is not a fault: nothing
        // is broken, the account simply may not write, so the status line
        // says so in its own words instead of "Sync completed with
        // errors", which sent people looking for a server problem that was
        // not there (ADR 0003 decision 8). Rust names the refusal; this
        // only chooses the sentence. Mirrors iOS `applyOutcome`.
        lastErrorDiagnostic = message
        statusMessage = LocalizedMessage(writeRefusalHeadline(refusal))
        errorMessage = LocalizedMessage(writeRefusalExplanation(refusal))
    } else if (message != null) {
        lastErrorDiagnostic = message
        statusMessage = LocalizedMessage("sync.status.error")
        errorMessage = specificFileFailure(summary)
            ?: LocalizedMessage("sync.errors.completedWithErrors")
    } else {
        lastErrorDiagnostic = null
        statusMessage = LocalizedMessage("sync.status.complete")
        errorMessage = null
    }
}

internal fun SyncManager.specificFileFailure(summary: SyncSummary): LocalizedMessage? {
    val oversized = summary.failures.filter { it.kind == "upload" && it.statusCode == 413u.toUShort() }
        .map { it.filename }
    val rejected = summary.failures.filter { it.kind == "rejected" }.map { it.filename }
    if (oversized.isNotEmpty() && rejected.isNotEmpty()) return LocalizedMessage(
        "sync.errors.uploadsTooLargeAndUnsupported",
        mapOf("oversized" to oversized.joinToString(", "), "unsupported" to rejected.joinToString(", ")),
    )
    if (oversized.isNotEmpty()) return LocalizedMessage(
        "sync.errors.uploadsTooLarge", mapOf("filenames" to oversized.joinToString(", ")),
    )
    if (rejected.isNotEmpty()) return LocalizedMessage(
        "sync.errors.unsupportedPaths", mapOf("filenames" to rejected.joinToString(", ")),
    )
    return null
}
