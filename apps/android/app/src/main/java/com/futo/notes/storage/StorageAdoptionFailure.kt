package com.futo.notes.storage

import com.futo.notes.localization.LocalizedMessage

internal enum class StorageAdoptionFailure {
    SYNC_CONNECTED,
    DRAFT_FLUSH_FAILED,
    JOURNAL_CLEAR_FAILED,
    PREFERENCE_SAVE_FAILED,
}

internal fun storageRefusalMessage(reason: StorageRefusalReason): LocalizedMessage =
    LocalizedMessage(
        when (reason) {
            StorageRefusalReason.DESTINATION_UNUSABLE -> "storage.android.folderUnavailable"
            StorageRefusalReason.SYNC_CONNECTED -> "storage.android.disconnectSyncFirst"
        },
    )

internal fun storageAdoptionFailureMessage(failure: StorageAdoptionFailure): LocalizedMessage =
    LocalizedMessage(
        when (failure) {
            StorageAdoptionFailure.SYNC_CONNECTED -> "storage.android.disconnectSyncFirst"
            StorageAdoptionFailure.DRAFT_FLUSH_FAILED -> "storage.android.adoptionSaveFailed"
            StorageAdoptionFailure.JOURNAL_CLEAR_FAILED -> "storage.android.adoptionRecordFailed"
            StorageAdoptionFailure.PREFERENCE_SAVE_FAILED ->
                "storage.android.adoptionPreferenceFailed"
        },
    )
