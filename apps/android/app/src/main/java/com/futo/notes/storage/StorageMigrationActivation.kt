package com.futo.notes.storage

import uniffi.futo_notes_ffi.VaultMigrationFinalization

internal enum class StorageActivationFailure {
    PREPARATION_DECLINED,
    FINALIZATION_RECORD_FAILED,
    DESTINATION_CHANGED,
    SOURCE_FINALIZATION_FAILED,
    ACTIVATION_RECORD_FAILED,
}

internal sealed interface StorageActivationOutcome {
    data object Restart : StorageActivationOutcome
    data class KeepSource(val failure: StorageActivationFailure) : StorageActivationOutcome
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
        return StorageActivationOutcome.KeepSource(StorageActivationFailure.PREPARATION_DECLINED)
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
                StorageActivationFailure.FINALIZATION_RECORD_FAILED,
            )
        }
        when (finalizeSource()) {
            VaultMigrationFinalization.FINALIZED -> false
            VaultMigrationFinalization.SOURCE_RETAINED -> true
            VaultMigrationFinalization.DESTINATION_CHANGED ->
                return StorageActivationOutcome.KeepSource(
                    StorageActivationFailure.DESTINATION_CHANGED,
                )
            null ->
                return StorageActivationOutcome.KeepSource(
                    StorageActivationFailure.SOURCE_FINALIZATION_FAILED,
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
                StorageActivationFailure.ACTIVATION_RECORD_FAILED,
            )
        }
    }

    val preferenceCommitted = commitPreference(prepared.to)
    if (preferenceCommitted && !cleanupRequired) clearJournal()
    return StorageActivationOutcome.Restart
}
