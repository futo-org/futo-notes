package com.futo.notes.storage

import uniffi.futo_notes_ffi.VaultMigrationFinalization

internal sealed interface StorageActivationOutcome {
    data object Restart : StorageActivationOutcome
    data class KeepSource(val feedback: String?) : StorageActivationOutcome
}

/**
 * Cross the staged-copy activation boundary without ever resuming a source
 * whose cleanup may have started.
 */
internal suspend fun activateStagedStorageMigration(
    prepared: PendingStorageMigration,
    decision: NotesStorage.StorageSwitchDecision,
    writeJournal: suspend (PendingStorageMigration) -> Boolean,
    finalizeSource: suspend () -> VaultMigrationFinalization?,
    commitPreference: suspend (StorageMode) -> Boolean,
    clearJournal: suspend () -> Unit,
): StorageActivationOutcome {
    if (!decision.commitPreference) {
        return StorageActivationOutcome.KeepSource(decision.feedback)
    }

    val isSourceRemovalForbidden =
        decision.requiresFinalization && prepared.from == StorageMode.DEVICE
    val cleanupRequired = if (decision.requiresFinalization) {
        val finalizing = prepared.copy(
            phase = StorageMigrationPhase.FINALIZING,
            cleanupRequired = false,
            isSourceRemovalForbidden = isSourceRemovalForbidden,
        )
        if (!writeJournal(finalizing)) {
            return StorageActivationOutcome.KeepSource(
                "The verified notes copy could not be prepared for activation."
            )
        }
        when (finalizeSource()) {
            VaultMigrationFinalization.FINALIZED -> false
            VaultMigrationFinalization.SOURCE_RETAINED -> true
            VaultMigrationFinalization.DESTINATION_CHANGED ->
                return StorageActivationOutcome.KeepSource(
                    "The current notes folder changed during the move. The original folder remains active."
                )
            null ->
                return StorageActivationOutcome.KeepSource(
                    "The current notes folder could not be finalized. The original folder remains active."
                )
        }
    } else {
        false
    }

    val activated = prepared.copy(
        phase = StorageMigrationPhase.ACTIVATED,
        cleanupRequired = cleanupRequired,
        isSourceRemovalForbidden = isSourceRemovalForbidden,
    )
    if (!writeJournal(activated)) {
        return if (decision.requiresFinalization) {
            StorageActivationOutcome.Restart
        } else {
            StorageActivationOutcome.KeepSource(
                "The verified notes copy could not be activated."
            )
        }
    }

    val preferenceCommitted = commitPreference(prepared.to)
    if (preferenceCommitted && !cleanupRequired) clearJournal()
    return StorageActivationOutcome.Restart
}
