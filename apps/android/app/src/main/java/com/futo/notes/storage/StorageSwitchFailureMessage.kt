package com.futo.notes.storage

import com.futo.notes.localization.LocalizedMessage

internal enum class StorageSwitchFailureStage {
    MIGRATION,
    ACTIVATION,
}

internal fun storageSwitchFailureStage(
    decision: NotesStorage.StorageSwitchDecision,
): StorageSwitchFailureStage =
    if (decision.commitPreference) {
        StorageSwitchFailureStage.ACTIVATION
    } else {
        StorageSwitchFailureStage.MIGRATION
    }

internal fun storageSwitchFailureMessage(stage: StorageSwitchFailureStage): LocalizedMessage =
    LocalizedMessage(
        when (stage) {
            StorageSwitchFailureStage.MIGRATION -> "storage.android.migrationFailed"
            StorageSwitchFailureStage.ACTIVATION -> "storage.android.activationFailed"
        },
    )
