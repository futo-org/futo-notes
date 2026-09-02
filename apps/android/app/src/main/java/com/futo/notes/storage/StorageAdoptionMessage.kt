package com.futo.notes.storage

import com.futo.notes.localization.LocalizedMessage

data class StorageAdoptionSummary(
    val destinationNotes: Int,
    val destinationLastModifiedMillis: Long,
    val currentPath: String,
    val currentNotes: Int,
    val currentTimeMillis: Long,
)

fun storageAdoptionMessage(
    summary: StorageAdoptionSummary,
    localizedRelativeTime: (Long) -> String,
): LocalizedMessage {
    val arguments = mapOf(
        "destinationNotes" to summary.destinationNotes,
        "currentNotes" to summary.currentNotes,
        "currentPath" to summary.currentPath,
    )
    val localizedLastChanged = summary.destinationLastModifiedMillis
        .takeIf { summary.destinationNotes > 0 && it > 0 && it <= summary.currentTimeMillis }
        ?.let(localizedRelativeTime)
    return if (localizedLastChanged == null) {
        LocalizedMessage("storage.android.adoption", arguments)
    } else {
        LocalizedMessage(
            "storage.android.adoptionWithLastChanged",
            arguments + ("lastChanged" to localizedLastChanged),
        )
    }
}
