package com.futo.notes.storage

import android.content.Context
import android.content.SharedPreferences
import com.futo.notes.Prefs

internal data class StorageStartupRecovery(
    val startup: NotesStorage.Startup?,
    val error: String?,
)

/**
 * Resolve an interrupted storage switch entirely off the main thread.
 *
 * FINALIZING is deliberately fail-closed while a removable source still
 * exists: the process may have died before cleanup or during a partial
 * removal. A retained-source record safely rolls back because it was persisted
 * before a Device source that policy forbids deleting was inspected.
 */
internal fun recoverStorageStartup(
    context: Context,
    preferences: SharedPreferences,
    journal: StorageMigrationJournal,
    isDebug: Boolean,
): StorageStartupRecovery {
    val pending = journal.read().getOrElse {
        return StorageStartupRecovery(
            startup = null,
            error =
                "The previous storage move could not be recovered. Both note folders were retained.",
        )
    }
    val savedMode = preferences.getString(Prefs.STORAGE_MODE, null)
    val effectiveMode = pending?.let { migration ->
        val sourceState =
            NotesStorage.sourceStateForRecovery(context, migration.from, isDebug)
        if (migration.phase == StorageMigrationPhase.FINALIZING) {
            when (sourceState) {
                StorageRootState.PRESENT ->
                    if (!migration.isSourceRemovalForbidden) {
                        return StorageStartupRecovery(
                            startup = null,
                            error =
                                "A storage move was interrupted during cleanup. Both note folders were retained.",
                        )
                    }
                StorageRootState.UNAVAILABLE ->
                    return StorageStartupRecovery(
                        startup = null,
                        error =
                            "The previous notes folder cannot be inspected. Reconnect its storage and restart.",
                    )
                StorageRootState.ABSENT -> Unit
            }
        }

        val recovery =
            NotesStorage.storageRecoveryDecision(savedMode, migration, sourceState)
        val preferenceReady = recovery.repairPreferenceTo?.let { repair ->
            preferences.edit().putString(Prefs.STORAGE_MODE, repair.name).commit()
        } ?: true
        if (!preferenceReady) {
            return StorageStartupRecovery(
                startup = null,
                error =
                    "The recovered notes folder could not be saved. Both note folders were retained.",
            )
        }

        when (migration.phase) {
            StorageMigrationPhase.PREPARED -> journal.clear()
            StorageMigrationPhase.FINALIZING -> {
                if (
                    migration.isSourceRemovalForbidden &&
                    sourceState == StorageRootState.PRESENT
                ) {
                    journal.clear()
                } else {
                    journal.write(
                        migration.copy(
                            phase = StorageMigrationPhase.ACTIVATED,
                            cleanupRequired = false,
                        )
                    )
                }
            }
            StorageMigrationPhase.ACTIVATED -> {
                if (
                    !migration.cleanupRequired ||
                    sourceState == StorageRootState.ABSENT
                ) {
                    journal.clear()
                }
            }
        }
        recovery.activeMode.name
    } ?: savedMode

    return StorageStartupRecovery(
        startup =
            NotesStorage.decideStartup(
                savedMode = effectiveMode,
                internalVaultExists =
                    NotesStorage.looksLikeExistingVault(NotesStorage.internalRoot(context)),
                deviceModeSupported = NotesStorage.deviceModeSupported(),
            ),
        error = null,
    )
}
